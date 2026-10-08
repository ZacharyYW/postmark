import type { TrackingEvent } from '@postmark/shared';
import { shortUrl, type Tone } from './format';

export interface ActivityItem {
  id: number;
  at: string;
  text: string;
  detail: string;
  tone: Tone;
  /** Not counted as a real open/click (privacy prefetch, scanner, or the sender's own view). */
  ignored: boolean;
}

/** Plain-language label for one tracking event. Never claims more certainty than we have. */
export function describeEvent(e: TrackingEvent): ActivityItem {
  const host = e.linkUrl ? shortUrl(e.linkUrl) : 'a link';
  const base = { id: e.id, at: e.occurredAt };
  if (e.type === 'click') {
    switch (e.uaClass) {
      case 'bot':
        return {
          ...base,
          text: `Link checked by a security scanner: ${host}`,
          detail: 'Automated link scanners follow links on delivery; not counted.',
          tone: 'muted',
          ignored: true,
        };
      case 'sender':
        return {
          ...base,
          text: `You clicked ${host}`,
          detail: 'Your own click; not counted.',
          tone: 'muted',
          ignored: true,
        };
      default:
        return {
          ...base,
          text: `Clicked ${host}`,
          detail: e.linkUrl ?? '',
          tone: 'info',
          ignored: false,
        };
    }
  }
  switch (e.uaClass) {
    case 'gmail_proxy':
      return {
        ...base,
        text: 'Opened (in Gmail)',
        detail:
          'Fetched through Gmail’s image proxy, which usually means a Gmail reader opened it.',
        tone: 'ok',
        ignored: false,
      };
    case 'other':
      return {
        ...base,
        text: 'Opened',
        detail: 'Loaded directly by a mail app or browser.',
        tone: 'ok',
        ignored: false,
      };
    case 'apple_mpp':
      return {
        ...base,
        text: 'Possibly auto-loaded (Apple Mail privacy)',
        detail:
          'Apple Mail Privacy Protection can load images without anyone reading; not counted as an open.',
        tone: 'warn',
        ignored: true,
      };
    case 'bot':
      return {
        ...base,
        text: 'Fetched by a security scanner',
        detail: 'Automated scanning, not a person; not counted.',
        tone: 'muted',
        ignored: true,
      };
    case 'sender':
      return {
        ...base,
        text: 'Your own view',
        detail: 'You viewed your own sent email; not counted.',
        tone: 'muted',
        ignored: true,
      };
  }
}

/** Who the activity can be attributed to, stated honestly. */
export function attribution(recipients: string[]): string {
  if (recipients.length === 1)
    return `Sent to ${recipients[0]}. Opens are most likely theirs (or anyone they forwarded it to).`;
  return `Sent to ${recipients.length} recipients. Everyone receives the same copy, so opens can’t be attributed to a specific person.`;
}

/** Newest first. */
export function buildActivity(events: TrackingEvent[]): ActivityItem[] {
  return events
    .map(describeEvent)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id);
}
