import { describe, expect, it, vi } from 'vitest';
import type { MessageSummary } from '@postmark/shared';
import { attachCompose, TOAST_UNTRACKED } from '../src/gmail/compose';
import { createHarness, FakeCompose, flush, SERVER, signIn } from './harness';

async function setup(opts: { signedIn?: boolean; tabAccount?: string | null } = {}) {
  const h = createHarness();
  if (opts.signedIn !== false) await signIn(h);
  const bus = h.busFor(7);
  if (opts.tabAccount !== null) {
    await bus.send('ACTIVE_ACCOUNT', { account: opts.tabAccount ?? 'Me@Work.com' });
  }
  const toasts: string[] = [];
  const attach = (c: FakeCompose, extra: { presendTimeoutMs?: number } = {}) =>
    attachCompose(c, {
      bus,
      adapter: { toast: (t) => toasts.push(t) },
      tabAccount: opts.tabAccount === undefined ? 'me@work.com' : opts.tabAccount,
      bindRetryDelaysMs: [0],
      ...extra,
    });
  const list = async () =>
    (await h.service.api.listMessages({ limit: 50 })).messages as MessageSummary[];
  return { h, bus, toasts, attach, list };
}

const BODY = `<div>Hi! See <a href="https://example.com/doc">the doc</a> and <a href="mailto:a@b.com">mail me</a>.</div>
<div class="gmail_quote"><a href="https://old.example.com">quoted</a></div>`;

describe('compose send flow (mocked Gmail adapter → real SW handlers → real server)', () => {
  it('tracks a send end-to-end: register message, rewrite links, insert pixel, bind ids', async () => {
    const { attach, list, toasts } = await setup();
    const c = new FakeCompose('compose-1', 'me@work.com', ['You@Example.com']);
    attach(c);
    await flush();
    expect(c.toggleOn).toBe(true);

    const sent = await c.send(BODY);
    await flush();
    await flush();

    expect(sent).toMatch(new RegExp(`href="${SERVER}/l/[\\w-]{21}"`));
    expect(sent).toContain('href="mailto:a@b.com"');
    expect(sent).toContain('href="https://old.example.com"');
    expect(sent).toMatch(new RegExp(`<img src="${SERVER}/p/[\\w-]{21}\\.gif"`));
    expect(sent.indexOf('<img')).toBeLessThan(sent.indexOf('gmail_quote'));
    expect(toasts).toEqual([]);

    const [m] = await list();
    expect(m).toMatchObject({
      senderAccount: 'me@work.com',
      recipients: ['you@example.com'],
      subject: 'Hello there',
      gmailThreadId: 'thr1',
      gmailMessageId: 'msg1',
    });
    expect(m!.links.map((l) => l.originalUrl)).toEqual(['https://example.com/doc']);
  });

  it('never sends the email body to the server', async () => {
    const h = createHarness();
    const bodies: string[] = [];
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(init.body);
      return h.fetchImpl(input, init);
    });
    // Rebuild service with spying fetch.
    const { PostmarkService } = await import('../src/background/service');
    const svc = new PostmarkService(spy as unknown as typeof fetch);
    const { dispatch } = await import('../src/bus/router');
    const { createBusClient } = await import('../src/bus/client');
    const bus = createBusClient((env) =>
      dispatch(
        svc.handlers(),
        env,
        { id: 'abcdefghijklmnopabcdefghijklmnop', tab: { id: 1 } },
        'abcdefghijklmnopabcdefghijklmnop',
      ),
    );
    await chrome.storage.local.set({ serverUrl: SERVER });
    const page = createBusClient((env) =>
      dispatch(
        svc.handlers(),
        env,
        {
          id: 'abcdefghijklmnopabcdefghijklmnop',
          url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html',
        },
        'abcdefghijklmnopabcdefghijklmnop',
      ),
    );
    await page.send('REGISTER', { email: 'p@x.com' });
    await bus.send('ACTIVE_ACCOUNT', { account: 'me@work.com' });
    const c = new FakeCompose('c-priv', 'me@work.com', ['you@x.com'], 'Subject line');
    attachCompose(c, {
      bus,
      adapter: { toast: () => {} },
      tabAccount: 'me@work.com',
      bindRetryDelaysMs: [0],
    });
    await c.send('<div>TOP SECRET BODY TEXT <a href="https://example.com">x</a></div>');
    await flush();
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toContain('TOP SECRET');
  });

  it('sends untracked when tracking is toggled off', async () => {
    const { attach, list } = await setup();
    const c = new FakeCompose('compose-2', 'me@work.com', ['you@example.com']);
    attach(c);
    await flush();
    c.toggleClick!();
    expect(c.toggleOn).toBe(false);
    expect(await c.send(BODY)).toBe(BODY);
    expect(await list()).toHaveLength(0);
  });

  it('respects a per-account tracking default of off', async () => {
    const { h, attach, list } = await setup();
    await h.busFor().send('UPDATE_ACCOUNT_SETTINGS', {
      account: 'me@work.com',
      settings: { trackingDefault: false },
    });
    const c = new FakeCompose('compose-3', 'me@work.com', ['you@example.com']);
    attach(c);
    await flush();
    await flush();
    expect(c.toggleOn).toBe(false);
    expect(await c.send(BODY)).toBe(BODY);
    expect(await list()).toHaveLength(0);
  });

  it('fails soft: server down → original body + "Sent without tracking" toast', async () => {
    const { h, attach, toasts } = await setup();
    const c = new FakeCompose('compose-4', 'me@work.com', ['you@example.com']);
    attach(c);
    await flush();
    h.network.down = true;
    expect(await c.send(BODY)).toBe(BODY);
    expect(toasts).toEqual([TOAST_UNTRACKED]);
  });

  it('fails soft on timeout (slow server)', async () => {
    const { h, attach, toasts } = await setup();
    const c = new FakeCompose('compose-5', 'me@work.com', ['you@example.com']);
    attach(c, { presendTimeoutMs: 50 });
    await flush();
    h.network.delayMs = 400;
    const started = Date.now();
    expect(await c.send(BODY)).toBe(BODY);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(toasts).toEqual([TOAST_UNTRACKED]);
  });

  it('double-track guard: a body that already has our pixel is sent as-is', async () => {
    const { attach, list } = await setup();
    const c1 = new FakeCompose('compose-6', 'me@work.com', ['you@example.com']);
    attach(c1);
    await flush();
    const tracked = await c1.send(BODY);
    await flush();
    const c2 = new FakeCompose('compose-7', 'me@work.com', ['you@example.com']);
    attach(c2);
    await flush();
    expect(await c2.send(tracked, { threadId: 'thr2', messageId: 'msg2' })).toBe(tracked);
    expect(await list()).toHaveLength(1);
  });

  it('replying to a tracked email still tracks the new message (old pixel is quoted)', async () => {
    const { attach, list } = await setup();
    const c1 = new FakeCompose('compose-8', 'me@work.com', ['you@example.com']);
    attach(c1);
    await flush();
    const tracked = await c1.send('<div>first</div>');
    await flush();
    const reply = `<div>my reply</div><div class="gmail_quote">${tracked}</div>`;
    const c2 = new FakeCompose('compose-9', 'me@work.com', ['you@example.com']);
    attach(c2);
    await flush();
    const out = await c2.send(reply, { threadId: 'thr1', messageId: 'msg9' });
    expect(out).not.toBe(reply);
    expect(await list()).toHaveLength(2);
  });

  it('Undo Send / resend of the same compose reuses one server message', async () => {
    const { attach, list } = await setup();
    const c = new FakeCompose('compose-10', 'me@work.com', ['you@example.com']);
    attach(c);
    await flush();
    // First attempt: modifier runs but Gmail never confirms (undo).
    const out1 = await c.modifier!({ body: BODY, isPlainText: false });
    // Resend.
    const out2 = await c.send(BODY);
    const pixelOf = (html: string) => /\/p\/([\w-]{21})\.gif/.exec(html)?.[1];
    expect(out1.body).not.toBe(BODY);
    expect(pixelOf(out2)).toBeDefined();
    expect(pixelOf(out2)).toBe(pixelOf(out1.body));
    await flush();
    expect(await list()).toHaveLength(1);
  });

  it('rapid double send while the first is in flight shares one preparation', async () => {
    const { h, attach, list } = await setup();
    const c = new FakeCompose('compose-11', 'me@work.com', ['you@example.com']);
    attach(c);
    await flush();
    h.network.delayMs = 30;
    const [a, b] = await Promise.all([
      c.modifier!({ body: BODY, isPlainText: false }),
      c.modifier!({ body: BODY, isPlainText: false }),
    ]);
    expect(a.body).toBe(b.body);
    expect(await list()).toHaveLength(1);
  });

  it('uses the "Send as" alias actually selected, even if changed mid-compose', async () => {
    const { attach, list, h } = await setup();
    const c = new FakeCompose('compose-12', 'me@work.com', ['you@example.com'], 'S', [
      'me@work.com',
      'Sales@Work.com',
    ]);
    attach(c);
    await flush();
    c.changeFrom('Sales@Work.com');
    await c.send(BODY);
    await flush();
    const [m] = await list();
    expect(m!.senderAccount).toBe('sales@work.com');
    const scope = await h.service.tabScope(7);
    expect(scope).toEqual({ account: 'me@work.com', aliases: ['sales@work.com'] });
  });

  it('sends untracked when the account cannot be determined', async () => {
    const { attach, list, toasts } = await setup({ tabAccount: null });
    const c = new FakeCompose('compose-13', null, ['you@example.com']);
    attach(c);
    await flush();
    expect(await c.send(BODY)).toBe(BODY);
    expect(toasts).toEqual([TOAST_UNTRACKED]);
    expect(await list()).toHaveLength(0);
  });

  it('plain-text mode is sent untracked with an explanatory toast', async () => {
    const { attach, toasts } = await setup();
    const c = new FakeCompose('compose-14', 'me@work.com', ['you@example.com']);
    attach(c);
    await flush();
    expect(await c.send('plain text', undefined, true)).toBe('plain text');
    expect(toasts[0]).toMatch(/Plain-text/);
  });

  it('not signed in → untracked with toast', async () => {
    const { attach, toasts } = await setup({ signedIn: false });
    const c = new FakeCompose('compose-15', 'me@work.com', ['you@example.com']);
    attach(c);
    await flush();
    expect(await c.send(BODY)).toBe(BODY);
    expect(toasts[0]).toMatch(/not signed in/);
  });

  it('adds the disclosure footer when enabled globally', async () => {
    const { h, attach } = await setup();
    await h.busFor().send('UPDATE_GLOBAL_SETTINGS', { disclosureFooter: true });
    const c = new FakeCompose('compose-16', 'me@work.com', ['you@example.com']);
    attach(c);
    await flush();
    expect(await c.send('<div>x</div>')).toContain('Read receipts enabled');
  });

  it('an account whose first send happens before /v1/accounts knows it still tracks', async () => {
    const { h, attach, list } = await setup({ tabAccount: 'brand.new@gmail.com' });
    const c = new FakeCompose('compose-17', 'brand.new@gmail.com', ['x@y.com']);
    attach(c);
    await flush();
    await c.send(BODY);
    await flush();
    expect((await list())[0]!.senderAccount).toBe('brand.new@gmail.com');
    const accts = await h.busFor().send('LIST_ACCOUNTS', {});
    expect(accts.ok && accts.data.accounts.map((a) => a.account)).toContain('brand.new@gmail.com');
  });
});

describe('send-path races', () => {
  it('discarding a draft never contacts the server', async () => {
    const h = createHarness();
    await signIn(h);
    const bus = h.busFor(7);
    await bus.send('ACTIVE_ACCOUNT', { account: 'me@work.com' });
    const c = new FakeCompose('discard-1', 'me@work.com', ['you@example.com']);
    attachCompose(c, {
      bus,
      adapter: { toast: () => {} },
      tabAccount: 'me@work.com',
    });
    await flush();
    // User types, then discards: Gmail never sends, so the modifier never runs.
    expect((await h.service.api.listMessages({ limit: 10 })).messages).toHaveLength(0);
  });

  it('server comes back after an offline send: next compose tracks normally', async () => {
    const h = createHarness();
    await signIn(h);
    const bus = h.busFor(7);
    await bus.send('ACTIVE_ACCOUNT', { account: 'me@work.com' });
    const deps = {
      bus,
      adapter: { toast: () => {} },
      tabAccount: 'me@work.com',
      bindRetryDelaysMs: [0],
    };
    const c1 = new FakeCompose('off-1', 'me@work.com', ['you@example.com']);
    attachCompose(c1, deps);
    await flush();
    h.network.down = true;
    expect(await c1.send('<div>a</div>')).toBe('<div>a</div>');
    h.network.down = false;
    const c2 = new FakeCompose('off-2', 'me@work.com', ['you@example.com']);
    attachCompose(c2, deps);
    await flush();
    expect(await c2.send('<div>b</div>')).toContain('/p/');
    await flush();
    expect((await h.service.api.listMessages({ limit: 10 })).messages).toHaveLength(1);
  });
});

describe('R2: hostile server responses', () => {
  it('refuses to insert tracking URLs outside the tracking origin', async () => {
    const { createBusClient } = await import('../src/bus/client');
    const bus = createBusClient(async (env) => {
      if (env.type === 'GET_AUTH_STATE')
        return { ok: true, data: { loggedIn: true, email: 'x', serverUrl: SERVER } };
      if (env.type === 'GET_SETTINGS')
        return {
          ok: true,
          data: {
            global: {},
            account: null,
            resolved: { trackingDefault: true, disclosureFooter: false },
          },
        };
      if (env.type === 'PREPARE_TRACKING')
        return {
          ok: true,
          data: {
            messageId: 'm',
            pixelId: 'p',
            pixelUrl: `${SERVER}/p/x.gif`,
            rewrittenLinks: [
              {
                original: 'https://example.com/doc',
                trackedUrl: 'javascript:alert(1)',
                linkId: 'l',
              },
            ],
          },
        };
      return { ok: true, data: { ok: true } };
    });
    const toasts: string[] = [];
    const c = new FakeCompose('hostile', 'me@work.com', ['you@example.com']);
    attachCompose(c, {
      bus,
      adapter: { toast: (t) => toasts.push(t) },
      tabAccount: 'me@work.com',
    });
    await flush();
    expect(await c.send(BODY)).toBe(BODY);
    expect(toasts).toEqual([TOAST_UNTRACKED]);
  });
});

describe('orphaned content script', () => {
  it('sends untracked with a "reload Gmail" toast instead of erroring', async () => {
    const { TOAST_RELOAD } = await import('../src/gmail/compose');
    const h = createHarness();
    await signIn(h);
    const bus = h.busFor(7);
    const toasts: string[] = [];
    const c = new FakeCompose('orphan', 'me@work.com', ['you@example.com']);
    attachCompose(c, {
      bus,
      adapter: { toast: (t) => toasts.push(t) },
      tabAccount: 'me@work.com',
      isAlive: () => false,
    });
    await flush();
    expect(await c.send(BODY)).toBe(BODY);
    expect(toasts).toEqual([TOAST_RELOAD]);
  });
});

describe('orphaned content script', () => {
  it('sends untracked with a "reload Gmail" toast instead of erroring', async () => {
    const { TOAST_RELOAD } = await import('../src/gmail/compose');
    const h = createHarness();
    await signIn(h);
    const bus = h.busFor(7);
    const toasts: string[] = [];
    const c = new FakeCompose('orphan', 'me@work.com', ['you@example.com']);
    attachCompose(c, {
      bus,
      adapter: { toast: (t) => toasts.push(t) },
      tabAccount: 'me@work.com',
      isAlive: () => false,
    });
    await flush();
    expect(await c.send(BODY)).toBe(BODY);
    expect(toasts).toEqual([TOAST_RELOAD]);
  });
});

describe('public tracking host differs from the API URL (e.g. an https tunnel)', () => {
  it('tracks with pixel/links on the public host and later recognises them as ours', async () => {
    const PUBLIC = 'https://abc-tunnel.trycloudflare.com';
    const h = createHarness({ publicBaseUrl: PUBLIC });
    await signIn(h);
    const bus = h.busFor(7);
    await bus.send('ACTIVE_ACCOUNT', { account: 'me@work.com' });
    const toasts: string[] = [];
    const deps = {
      bus,
      adapter: { toast: (t: string) => toasts.push(t) },
      tabAccount: 'me@work.com',
      bindRetryDelaysMs: [0],
    };
    const c1 = new FakeCompose('pub-1', 'me@work.com', ['you@example.com']);
    attachCompose(c1, deps);
    await flush();
    const sent = await c1.send(BODY);
    expect(toasts).toEqual([]);
    expect(sent).toContain(`${PUBLIC}/p/`);
    expect(sent).toContain(`${PUBLIC}/l/`);
    await flush();
    // Forwarding that exact body again: our public-host pixel is recognised → not double-tracked.
    const c2 = new FakeCompose('pub-2', 'me@work.com', ['you@example.com']);
    attachCompose(c2, deps);
    await flush();
    expect(await c2.send(sent, { threadId: 't2', messageId: 'm2' })).toBe(sent);
  });

  it('rejects a plain-http public host that is not localhost', async () => {
    const h = createHarness({ publicBaseUrl: 'http://track.example.com' });
    await signIn(h);
    const bus = h.busFor(7);
    await bus.send('ACTIVE_ACCOUNT', { account: 'me@work.com' });
    const toasts: string[] = [];
    const c = new FakeCompose('pub-3', 'me@work.com', ['you@example.com']);
    attachCompose(c, { bus, adapter: { toast: (t) => toasts.push(t) }, tabAccount: 'me@work.com' });
    await flush();
    expect(await c.send(BODY)).toBe(BODY);
    expect(toasts).toEqual([TOAST_UNTRACKED]);
  });
});
