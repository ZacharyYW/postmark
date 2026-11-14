import { isHttpUrl } from './urls';

/** Shape of a Postmark login token (base64url, as issued by /v1/auth/register). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;

/**
 * A connection string bundles the login token with the server it belongs to, so a second
 * browser/install can be connected by pasting one value: `<token>@<serverUrl>`.
 * Tokens never contain `@`, so the first `@` is always the separator.
 */
export function formatConnectionString(token: string, serverUrl: string): string {
  return `${token}@${serverUrl.replace(/\/+$/, '')}`;
}

/**
 * Accepts either a full connection string or a bare token (older installs, `npm run seed`).
 * Returns null when the input is neither.
 */
export function parseConnectionString(
  raw: string,
): { token: string; serverUrl: string | null } | null {
  const trimmed = raw.trim();
  const at = trimmed.indexOf('@');
  if (at === -1) return TOKEN_PATTERN.test(trimmed) ? { token: trimmed, serverUrl: null } : null;
  const token = trimmed.slice(0, at);
  const serverUrl = trimmed.slice(at + 1).replace(/\/+$/, '');
  if (!TOKEN_PATTERN.test(token) || !isHttpUrl(serverUrl)) return null;
  return { token, serverUrl };
}
