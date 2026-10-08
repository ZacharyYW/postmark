import { LIMITS } from './constants';

/** True only for absolute http(s) URLs. Used both at registration and before redirecting. */
export function isHttpUrl(raw: string): boolean {
  if (raw.length > LIMITS.URL_MAX) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Normalise an origin string (scheme://host[:port]) for comparisons. */
export function toOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Whether an `<a href>` in an outgoing email should be rewritten to a tracked redirect.
 * Skips mailto:, tel:, fragment-only, relative, javascript:, and links already pointing at the
 * tracking server.
 */
export function isTrackableHref(href: string | null | undefined, trackingOrigin: string): boolean {
  if (!href) return false;
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return false;
  if (!isHttpUrl(trimmed)) return false;
  const origin = toOrigin(trimmed);
  const trackOrigin = toOrigin(trackingOrigin);
  if (origin !== null && trackOrigin !== null && origin === trackOrigin) return false;
  return true;
}

/** Deep link to a Gmail thread under a specific account. */
export function gmailThreadUrl(threadId: string, account?: string | null): string {
  const params = account ? `?authuser=${encodeURIComponent(account)}` : '';
  return `https://mail.google.com/mail/${params}#all/${encodeURIComponent(threadId)}`;
}
