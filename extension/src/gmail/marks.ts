import { absoluteTime, relativeTime, type MessageSummary } from '@postmark/shared';
import type { MarkIcon } from './adapter';

export type IconUrl = (name: 'sent' | 'opened' | 'auto' | 'click') => string;

/** The latest tracked message in a thread drives that row's marks. */
export function pickLatest(messages: MessageSummary[]): MessageSummary | null {
  if (messages.length === 0) return null;
  return [...messages].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))[0]!;
}

const at = (iso: string | null) => (iso ? `${relativeTime(iso)} — ${absoluteTime(iso)}` : '');

/** Row marks for the Sent list: grey ✓✓ sent, green ✓✓ opened, amber ✓✓ possibly auto-loaded, plus a link icon. */
export function marksFor(
  messages: MessageSummary[],
  iconUrl: IconUrl,
): { status: MarkIcon | null; clicks: MarkIcon | null } {
  const m = pickLatest(messages);
  if (!m) return { status: null, clicks: null };
  let status: MarkIcon;
  if (m.opens.total > 0) {
    status = {
      iconUrl: iconUrl('opened'),
      tooltip: `Postmark: likely opened ${m.opens.total === 1 ? 'once' : `${m.opens.total} times`} · last ${at(m.opens.last)}`,
    };
  } else if (m.opens.autoLoaded > 0) {
    status = {
      iconUrl: iconUrl('auto'),
      tooltip:
        'Postmark: possibly auto-loaded (e.g. Apple Mail Privacy Protection), not counted as opened',
    };
  } else {
    status = { iconUrl: iconUrl('sent'), tooltip: 'Postmark: sent, not opened yet' };
  }
  const clicks: MarkIcon | null =
    m.clicks.total > 0
      ? {
          iconUrl: iconUrl('click'),
          tooltip: `Postmark: ${m.clicks.total} link click${m.clicks.total === 1 ? '' : 's'} · last ${at(m.clicks.last)}`,
        }
      : null;
  return { status, clicks };
}
