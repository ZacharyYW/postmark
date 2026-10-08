import { absoluteTime, relativeTime, type MessageSummary } from '@postmark/shared';

export type Tone = 'muted' | 'ok' | 'warn' | 'info';

export interface StatusView {
  label: string;
  tone: Tone;
  /** Longer, honest explanation for tooltips / screen readers. */
  detail: string;
}

const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

function when(iso: string | null): string {
  if (!iso) return '';
  return `${relativeTime(iso)} (${absoluteTime(iso)})`;
}

export function statusView(m: MessageSummary): StatusView {
  const { opens, clicks } = m;
  switch (m.status) {
    case 'clicked':
      return {
        label: clicks.total === 1 ? 'Link clicked' : `${clicks.total} link clicks`,
        tone: 'info',
        detail: `Link clicked ${times(clicks.total)}, last ${when(clicks.last)}.${
          opens.total > 0 ? ` Likely opened ${times(opens.total)}.` : ''
        }`,
      };
    case 'opened':
      return {
        label: opens.total === 1 ? 'Opened' : `Opened ${opens.total}×`,
        tone: 'ok',
        detail: `Likely opened ${times(opens.total)}. First ${when(opens.first)}, last ${when(opens.last)}.`,
      };
    case 'auto_loaded':
      return {
        label: 'Possibly auto-loaded',
        tone: 'warn',
        detail:
          'The tracking image was fetched in a way that looks like automatic loading (e.g. Apple Mail Privacy Protection). This may not mean a person opened it.',
      };
    default:
      return {
        label: 'Not opened yet',
        tone: 'muted',
        detail:
          'Sent. No open detected yet. Recipients who block images will never show as opened.',
      };
  }
}

export function recipientsLabel(r: string[]): string {
  if (r.length === 0) return '(no recipients)';
  if (r.length === 1) return r[0]!;
  return `${r[0]} +${r.length - 1}`;
}

export function lastEventLabel(m: MessageSummary): { text: string; title: string } {
  const iso = m.lastEvent?.occurredAt ?? m.sentAt;
  const prefix = !m.lastEvent
    ? 'Sent'
    : m.lastEvent.type === 'click'
      ? 'Clicked'
      : m.lastEvent.uaClass === 'apple_mpp'
        ? 'Possibly auto-loaded'
        : 'Opened';
  return { text: `${prefix} ${relativeTime(iso)}`, title: absoluteTime(iso) };
}

/** "example.com/pricing" — host plus a short path, so two links on one site stay distinguishable. */
export function shortUrl(url: string, max = 40): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    const out = `${u.hostname.replace(/^www\./, '')}${path}`;
    return out.length > max ? `${out.slice(0, max - 1)}…` : out;
  } catch {
    return url;
  }
}
