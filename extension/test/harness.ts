import type { BusEnvelope } from '@postmark/shared';
import { createApp } from '../../server/src/app';
import { openDb } from '../../server/src/db/db';
import { loadEnv } from '../../server/src/env';
import { TokenBucketLimiter } from '../../server/src/middleware/rateLimit';
import { createBusClient, type BusClient } from '../src/bus/client';
import { dispatch } from '../src/bus/router';
import { PostmarkService } from '../src/background/service';
import type { BodyModifier, ComposeHandle } from '../src/gmail/adapter';

export const SERVER = 'http://pm.test';
export const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

/** Spins up the real server (in-memory SQLite) and the real SW service wired through the bus. */
export function createHarness() {
  const clock = { now: Date.parse('2026-03-01T12:00:00Z') };
  const db = openDb(':memory:');
  const big = () => new TokenBucketLimiter(100_000, 10_000);
  const server = createApp({
    db,
    env: loadEnv({ PUBLIC_BASE_URL: SERVER, IP_HASH_SALT: 'harness-salt-1234567' }),
    now: () => clock.now,
    getSocketIp: () => '198.51.100.20',
    limiters: { publicByIp: big(), registerByIp: big(), apiByUser: big() },
  });
  const network = { down: false, delayMs: 0 };
  const fetchImpl: typeof fetch = async (input, init) => {
    if (network.down) throw new TypeError('Failed to fetch');
    if (network.delayMs) await new Promise((r) => setTimeout(r, network.delayMs));
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return server.app.request(String(input), init as RequestInit);
  };
  const service = new PostmarkService(fetchImpl);
  const handlers = service.handlers();

  /** A bus client that behaves like a content script in `tabId` (or an extension page if undefined). */
  const busFor = (tabId?: number): BusClient =>
    createBusClient((env: BusEnvelope) =>
      dispatch(
        handlers,
        env,
        tabId === undefined
          ? { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` }
          : { id: EXT_ID, tab: { id: tabId }, url: 'https://mail.google.com/mail/u/0/' },
        EXT_ID,
      ),
    );

  return { clock, server, service, handlers, busFor, network, fetchImpl };
}

export async function signIn(h: ReturnType<typeof createHarness>, email = 'me@postmark.test') {
  await chrome.storage.local.set({ serverUrl: SERVER });
  const r = await h.busFor().send('REGISTER', { email });
  if (!r.ok) throw new Error(r.error.message);
}

export class FakeCompose implements ComposeHandle {
  modifier: BodyModifier | null = null;
  toggleOn: boolean | null = null;
  toggleClick: (() => void) | null = null;
  private sentCbs: ((ids: { threadId: string | null; messageId: string | null }) => void)[] = [];
  private fromCbs: (() => void)[] = [];
  constructor(
    public id: string,
    public from: string | null,
    public recipients: string[],
    public subject = 'Hello there',
    public fromChoices: string[] = [],
  ) {}
  getFromAddress() {
    return this.from;
  }
  getFromChoices() {
    return this.fromChoices;
  }
  getSubject() {
    return this.subject;
  }
  getRecipients() {
    return this.recipients;
  }
  isReply() {
    return false;
  }
  addToggleButton(opts: { initialOn: boolean; onClick: () => void }) {
    this.toggleOn = opts.initialOn;
    this.toggleClick = opts.onClick;
    return { setOn: (on: boolean) => (this.toggleOn = on) };
  }
  registerBodyModifier(fn: BodyModifier) {
    this.modifier = fn;
  }
  onSent(cb: (ids: { threadId: string | null; messageId: string | null }) => void) {
    this.sentCbs.push(cb);
  }
  onFromChanged(cb: () => void) {
    this.fromCbs.push(cb);
  }
  onDestroy() {}
  /** Simulates Gmail's send: run the modifier (as InboxSDK would), then fire `sent`. */
  async send(body: string, ids = { threadId: 'thr1', messageId: 'msg1' }, isPlainText = false) {
    const out = this.modifier ? await this.modifier({ body, isPlainText }) : { body };
    this.sentCbs.forEach((cb) => cb(ids));
    return out.body;
  }
  changeFrom(addr: string) {
    this.from = addr;
    this.fromCbs.forEach((cb) => cb());
  }
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
