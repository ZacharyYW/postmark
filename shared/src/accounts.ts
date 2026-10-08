const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** Canonical form of a Gmail account / sender address: trimmed and lower-cased. */
export function normalizeAccount(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  // Accept "Name <addr@x.com>" forms defensively.
  const angle = /<([^>]+)>/.exec(trimmed);
  const addr = (angle?.[1] ?? trimmed).trim();
  if (addr.length === 0 || addr.length > 254) return null;
  return EMAIL_RE.test(addr) ? addr : null;
}

/** Short label for chips: local part for long addresses. */
export function accountChipLabel(account: string): string {
  return account.length <= 24 ? account : (account.split('@')[0] ?? account);
}
