import {
  COUNTED_CLICK_CLASSES,
  COUNTED_OPEN_CLASSES,
  isInQuietHours,
  type ResolvedSettings,
  type TrackingEvent,
} from '@postmark/shared';

export interface NotificationSpec {
  id: string;
  kind: 'open' | 'click' | 'reminder' | 'summary';
  title: string;
  message: string;
  contextMessage?: string;
  messageId: string | null;
  threadId: string | null;
  account: string | null;
}

export interface PlanContext {
  resolve: (account: string) => ResolvedSettings;
  /** Name the account in notifications only when more than one is known (spec 6.5). */
  multiAccount: boolean;
  now: Date;
  maxPerBatch?: number;
}

export interface Plan {
  show: NotificationSpec[];
  queued: NotificationSpec[];
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function recipientsLabel(r: string[]): string {
  if (r.length === 0) return 'recipient';
  return r.length === 1 ? r[0]! : `${r[0]} +${r.length - 1}`;
}

function hostOf(url: string | null): string {
  if (!url) return 'a link';
  try {
    return new URL(url).hostname;
  } catch {
    return 'a link';
  }
}

/**
 * Turn polled events into notifications: one per message per event type (bursts are batched),
 * first opens only, counted classes only, respecting per-account settings and quiet hours.
 */
export function planNotifications(events: TrackingEvent[], ctx: PlanContext): Plan {
  const max = ctx.maxPerBatch ?? 5;
  const byKey = new Map<string, TrackingEvent[]>();
  for (const e of events) {
    const counted =
      e.type === 'open'
        ? e.isFirst && COUNTED_OPEN_CLASSES.includes(e.uaClass)
        : COUNTED_CLICK_CLASSES.includes(e.uaClass);
    if (!counted) continue;
    const key = `${e.type}:${e.messageId}`;
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }

  const show: NotificationSpec[] = [];
  const queued: NotificationSpec[] = [];
  for (const [key, group] of byKey) {
    const e = group[0]!;
    const settings = ctx.resolve(e.senderAccount);
    if (e.type === 'open' && !settings.notifyFirstOpen) continue;
    if (e.type === 'click' && !settings.notifyClick) continue;
    const via = ctx.multiAccount ? ` · via ${e.senderAccount}` : '';
    const subject = truncate(e.subject || '(no subject)', 80);
    const spec: NotificationSpec =
      e.type === 'open'
        ? {
            id: `pm:${key}`,
            kind: 'open',
            title: `Opened: ${subject}`,
            message: `${recipientsLabel(e.recipients)} likely opened your email${via}`,
            contextMessage: 'Open tracking is an estimate, not proof of reading',
            messageId: e.messageId,
            threadId: e.gmailThreadId,
            account: e.senderAccount,
          }
        : {
            id: `pm:${key}:${group[group.length - 1]!.id}`,
            kind: 'click',
            title:
              group.length === 1
                ? `Link clicked: ${hostOf(e.linkUrl)}`
                : `${group.length} link clicks`,
            message: `${subject}${via}`,
            messageId: e.messageId,
            threadId: e.gmailThreadId,
            account: e.senderAccount,
          };
    if (isInQuietHours(settings.quietHours, ctx.now)) queued.push(spec);
    else show.push(spec);
  }

  if (show.length > max) {
    const extra = show.splice(max - 1);
    show.push({
      id: `pm:summary:${ctx.now.getTime()}`,
      kind: 'summary',
      title: 'Postmark',
      message: `${extra.length} more tracking updates`,
      messageId: null,
      threadId: null,
      account: null,
    });
  }
  return { show, queued };
}

/** Summary shown once quiet hours end. */
export function summarizeQueue(
  queue: { kind: 'open' | 'click' | 'reminder' }[],
  now: Date,
): NotificationSpec | null {
  if (queue.length === 0) return null;
  const opens = queue.filter((q) => q.kind === 'open').length;
  const clicks = queue.filter((q) => q.kind === 'click').length;
  const reminders = queue.filter((q) => q.kind === 'reminder').length;
  const parts = [
    opens && `${opens} open${opens > 1 ? 's' : ''}`,
    clicks && `${clicks} click${clicks > 1 ? 's' : ''}`,
    reminders && `${reminders} reminder${reminders > 1 ? 's' : ''}`,
  ].filter(Boolean);
  return {
    id: `pm:quiet-summary:${now.getTime()}`,
    kind: 'summary',
    title: 'While notifications were paused',
    message: parts.join(', '),
    messageId: null,
    threadId: null,
    account: null,
  };
}
