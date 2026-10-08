import { h, render } from 'preact';
import { normalizeAccount, type MessageSummary, type PushMap } from '@postmark/shared';
import type { BusClient } from '../bus/client';
import { TrackingStrip } from '../ui/components/TrackingStrip';
import type { GmailAdapter, MessageViewHandle } from './adapter';
import { logOnce } from './safe';
import { createShadowHost } from './shadow';
import stripCss from './strip.css?inline';

export interface ThreadStripDeps {
  adapter: Pick<GmailAdapter, 'onMessageView'>;
  bus: BusClient;
  /** Accounts that count as "this tab" (primary + aliases), lower-cased. */
  scope: () => string[];
  onUpdate: (fn: (p: PushMap['DATA_UPDATED']) => void) => () => void;
  storage?: { get(): Promise<boolean>; set(v: boolean): Promise<void> };
  cacheMs?: number;
}

const defaultStorage = {
  async get() {
    const r = await chrome.storage.local.get('stripCollapsed');
    return r.stripCollapsed === true;
  },
  async set(v: boolean) {
    await chrome.storage.local.set({ stripCollapsed: v });
  },
};

/** Choose the tracked message a Gmail message view corresponds to. */
export function matchMessage(
  candidates: MessageSummary[],
  gmailMessageId: string | null,
  claimed: Set<string>,
): MessageSummary | null {
  if (gmailMessageId) {
    const exact = candidates.find((c) => c.gmailMessageId === gmailMessageId);
    if (exact) return exact;
  }
  // Unbound (PATCH never landed): only guess when there is exactly one unclaimed, unbound candidate.
  const unbound = candidates.filter((c) => c.gmailMessageId === null && !claimed.has(c.id));
  return unbound.length === 1 ? unbound[0]! : null;
}

export function startThreadStrips(deps: ThreadStripDeps) {
  const storage = deps.storage ?? defaultStorage;
  const cache = new Map<string, { at: number; p: Promise<MessageSummary[]> }>();
  const mounted = new Map<string, Set<() => void>>(); // threadId → refreshers
  const reportedReply = new Set<string>();

  const fetchThread = (threadId: string, force = false): Promise<MessageSummary[]> => {
    const hit = cache.get(threadId);
    if (!force && hit && Date.now() - hit.at < (deps.cacheMs ?? 5000)) return hit.p;
    const p = deps.bus.send('GET_THREAD_TRACKING', { threadId }).then((r) => {
      if (!r.ok) {
        if (r.error.code !== 'NOT_AUTHENTICATED')
          logOnce(`thread strip: ${r.error.code}`, r.error.message);
        return [];
      }
      return r.data.messages;
    });
    cache.set(threadId, { at: Date.now(), p });
    return p;
  };

  const attach = async (mv: MessageViewHandle) => {
    const sender = normalizeAccount(mv.getSenderEmail());
    const scope = deps.scope();
    // Only this tab's own outgoing messages; never show another account's data here.
    if (!sender || !scope.includes(sender)) return;
    const [threadId, gmailMessageId] = await Promise.all([mv.getThreadId(), mv.getMessageId()]);
    if (!threadId) return;
    const claimed = new Set<string>();
    const message = matchMessage(await fetchThread(threadId), gmailMessageId, claimed);
    if (!message || !scope.includes(message.senderAccount)) return;
    claimed.add(message.id);

    const { host, mount } = createShadowHost(stripCss);
    if (!mv.mountAboveBody(host)) {
      logOnce('thread strip: no mount point');
      return;
    }
    let collapsed = await storage.get().catch(() => false);
    let current = message;
    const draw = () =>
      render(
        h(TrackingStrip, {
          message: current,
          collapsed,
          onToggle: (c: boolean) => {
            collapsed = c;
            void storage.set(c);
            draw();
          },
          onRemind: async (at, condition) => {
            const r = await deps.bus.send('CREATE_REMINDER', {
              messageId: current.id,
              remindAt: at.toISOString(),
              condition,
            });
            if (!r.ok) throw new Error(r.error.message);
          },
        }),
        mount,
      );
    draw();

    // Self-view beacon: the sender is looking at their own message right now.
    void deps.bus.send('SELF_VIEW', { messageId: message.id });

    // Reply detection (for "no reply" reminders): a later message from someone outside this tab's accounts.
    const later = mv.getLaterSenders().map(normalizeAccount);
    if (
      !message.repliedAt &&
      !reportedReply.has(message.id) &&
      later.some((s) => s && !scope.includes(s))
    ) {
      reportedReply.add(message.id);
      void deps.bus.send('REPORT_REPLY', { messageId: message.id });
    }

    const refresh = async () => {
      const fresh = matchMessage(await fetchThread(threadId, true), gmailMessageId, new Set());
      if (fresh && fresh.id === current.id) {
        current = fresh;
        draw();
      }
    };
    let set = mounted.get(threadId);
    if (!set) mounted.set(threadId, (set = new Set()));
    set.add(refresh);
    mv.onDestroy(() => {
      set.delete(refresh);
      render(null, mount);
      host.remove();
    });
  };

  deps.adapter.onMessageView((mv) => {
    const go = () => void attach(mv).catch((err: unknown) => logOnce('thread strip failed', err));
    if (mv.isLoaded()) go();
    else mv.onLoad(go);
  });

  const off = deps.onUpdate((p) => {
    for (const t of p.threadIds) for (const refresh of mounted.get(t) ?? []) void refresh();
  });

  return { stop: off };
}
