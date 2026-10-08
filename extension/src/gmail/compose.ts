import { normalizeAccount, TIMING, toOrigin } from '@postmark/shared';
import type { BusClient } from '../bus/client';
import { applyTracking, collectLinks, hasPostmarkPixel } from '../compose/rewriteBody';
import type { ComposeHandle, GmailAdapter } from './adapter';
import { extensionAlive, logOnce, withTimeout } from './safe';

export interface ComposeDeps {
  bus: BusClient;
  adapter: Pick<GmailAdapter, 'toast'>;
  /** The Gmail account active in this tab. */
  tabAccount: string | null;
  /** Called when a compose reveals "Send as" aliases for this tab. */
  onAliases?: (aliases: string[]) => void;
  presendTimeoutMs?: number;
  bindRetryDelaysMs?: number[];
  /** Whether the extension context is still valid (false after an extension reload). */
  isAlive?: () => boolean;
}

export interface ComposeState {
  on: boolean;
  touched: boolean;
  messageId: string | null;
  inFlight: Promise<{ body: string }> | null;
}

export const TOAST_UNTRACKED = 'Sent without tracking';
export const TOAST_RELOAD =
  'Postmark was updated: reload Gmail to turn tracking back on. Sent without tracking.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wire tracking into one compose window. Returns its state for tests/debugging. */
export function attachCompose(compose: ComposeHandle, deps: ComposeDeps): ComposeState {
  const state: ComposeState = { on: true, touched: false, messageId: null, inFlight: null };
  const timeoutMs = deps.presendTimeoutMs ?? TIMING.PRESEND_TIMEOUT_MS;

  const senderAccount = () =>
    normalizeAccount(compose.getFromAddress()) ?? normalizeAccount(deps.tabAccount);

  const choices = compose
    .getFromChoices()
    .map(normalizeAccount)
    .filter((a): a is string => !!a);
  if (choices.length > 0) deps.onAliases?.(choices);

  const button = compose.addToggleButton({
    initialOn: state.on,
    onClick: () => {
      state.on = !state.on;
      state.touched = true;
      button.setOn(state.on);
    },
  });

  // Default from settings for the current From account; don't override a user's explicit choice.
  const applyDefault = async () => {
    const r = await deps.bus.send('GET_SETTINGS', { account: senderAccount() });
    if (r.ok && !state.touched) {
      state.on = r.data.resolved.trackingDefault;
      button.setOn(state.on);
    }
  };
  void applyDefault();
  compose.onFromChanged(() => void applyDefault());

  const untracked = (body: string, toast: string | null = TOAST_UNTRACKED) => {
    if (toast) deps.adapter.toast(toast);
    return { body };
  };

  const prepare = async (body: string, isPlainText: boolean): Promise<{ body: string }> => {
    if (!state.on) return { body };
    if (!(deps.isAlive ?? extensionAlive)()) return untracked(body, TOAST_RELOAD);
    if (isPlainText) return untracked(body, 'Plain-text message sent without tracking');
    const sender = senderAccount();
    if (!sender) return untracked(body); // never guess the account

    const auth = await deps.bus.send('GET_AUTH_STATE', {}, { timeoutMs: 1000 });
    if (!auth.ok || !auth.data.loggedIn) {
      return untracked(body, 'Postmark: not signed in, sent without tracking');
    }
    const origin = toOrigin(auth.data.serverUrl);
    if (!origin) return untracked(body);

    if (hasPostmarkPixel(body, origin)) return { body }; // already tracked (draft resend)

    const recipients = [
      ...new Set(
        compose
          .getRecipients()
          .map(normalizeAccount)
          .filter((r): r is string => !!r),
      ),
    ];
    if (recipients.length === 0) return { body };

    const settings = await deps.bus.send('GET_SETTINGS', { account: sender }, { timeoutMs: 1000 });
    const links = collectLinks(body, origin);
    const res = await deps.bus.send(
      'PREPARE_TRACKING',
      {
        clientRequestId: `${sender}:${compose.id}`,
        senderAccount: sender,
        subject: compose.getSubject().slice(0, 998),
        recipients: recipients.slice(0, 100),
        links: links.slice(0, 200),
      },
      { timeoutMs },
    );
    if (!res.ok) {
      logOnce(`prepare failed: ${res.error.code}`, res.error.message);
      return untracked(body);
    }
    // Defence in depth: only ever insert URLs on the configured tracking server
    // (a misconfigured or hostile server must not be able to inject other URLs into mail).
    const onOrigin = (u: string, path: string) => {
      try {
        const url = new URL(u);
        return url.origin === origin && url.pathname.startsWith(path);
      } catch {
        return false;
      }
    };
    if (
      !onOrigin(res.data.pixelUrl, '/p/') ||
      !res.data.rewrittenLinks.every((l) => onOrigin(l.trackedUrl, '/l/'))
    ) {
      logOnce('server returned tracking URLs outside the tracking origin; sending untracked');
      return untracked(body);
    }
    state.messageId = res.data.messageId;
    return {
      body: applyTracking(body, {
        trackingOrigin: origin,
        pixelUrl: res.data.pixelUrl,
        rewrittenLinks: res.data.rewrittenLinks,
        disclosureFooter: settings.ok ? settings.data.resolved.disclosureFooter : false,
      }),
    };
  };

  compose.registerBodyModifier(async ({ body, isPlainText }) => {
    // Rapid double-send: reuse the in-flight preparation instead of minting a second message.
    if (state.inFlight) return state.inFlight;
    const run = withTimeout(
      prepare(body, isPlainText).catch((err: unknown) => {
        logOnce('presend error', err);
        return untracked(body);
      }),
      timeoutMs + 500,
      () => untracked(body),
    );
    state.inFlight = run;
    try {
      return await run;
    } finally {
      state.inFlight = null;
    }
  });

  compose.onSent(({ threadId, messageId }) => {
    const id = state.messageId;
    if (!id) return;
    void (async () => {
      const delays = deps.bindRetryDelaysMs ?? [0, 1000, 3000, 9000];
      for (const d of delays) {
        if (d) await sleep(d);
        const r = await deps.bus.send('BIND_SENT', {
          messageId: id,
          gmailThreadId: threadId,
          gmailMessageId: messageId,
        });
        if (r.ok || r.error.code === 'VALIDATION' || r.error.code === 'NOT_FOUND') return;
      }
      logOnce('bind failed after retries');
    })();
  });

  return state;
}
