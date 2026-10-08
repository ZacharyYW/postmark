import type { MessageSummary } from '@postmark/shared';

let n = 0;
export function summary(o: Partial<MessageSummary> = {}): MessageSummary {
  n++;
  return {
    id: `m${n}`,
    senderAccount: 'a@work.com',
    gmailThreadId: `t${n}`,
    gmailMessageId: `g${n}`,
    subject: `Subject ${n}`,
    recipients: ['you@example.com'],
    sentAt: new Date(Date.now() - 3_600_000).toISOString(),
    trackingEnabled: true,
    repliedAt: null,
    opens: { total: 0, unique: 0, autoLoaded: 0, first: null, last: null },
    clicks: { total: 0, last: null },
    links: [],
    lastEvent: null,
    status: 'sent',
    ...o,
  };
}

export const opened = (o: Partial<MessageSummary> = {}) =>
  summary({
    opens: {
      total: 3,
      unique: 2,
      autoLoaded: 0,
      first: new Date(Date.now() - 1_800_000).toISOString(),
      last: new Date(Date.now() - 600_000).toISOString(),
    },
    status: 'opened',
    lastEvent: {
      type: 'open',
      occurredAt: new Date(Date.now() - 600_000).toISOString(),
      uaClass: 'gmail_proxy',
    },
    ...o,
  });
