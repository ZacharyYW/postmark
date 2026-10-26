/**
 * Host permissions Postmark needs at runtime. Chrome grants manifest `host_permissions` at
 * install; Firefox lets the user withhold or revoke them (about:addons → Permissions), and then
 * the Gmail content script silently never runs and server calls fail. The UI checks these and
 * offers a one-click grant.
 */

export const GMAIL_PATTERN = 'https://mail.google.com/*';

/** Match pattern for an origin (match patterns ignore ports). */
export function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

export interface HostPermissions {
  /** Patterns from {Gmail, server origin} that are not currently granted. */
  missing(serverUrl: string): Promise<string[]>;
  /** Prompt for the given patterns (must run inside a user gesture). */
  request(patterns: string[]): Promise<boolean>;
}

export const browserHostPermissions: HostPermissions = {
  async missing(serverUrl) {
    const wanted = [GMAIL_PATTERN];
    try {
      if (serverUrl) wanted.push(originPattern(serverUrl));
    } catch {
      // Invalid server URL: the connection card reports that; nothing to check here.
    }
    const out: string[] = [];
    for (const p of wanted) {
      try {
        if (!(await chrome.permissions.contains({ origins: [p] }))) out.push(p);
      } catch {
        // API unavailable: assume granted rather than nag.
      }
    }
    return out;
  },
  async request(patterns) {
    try {
      return await chrome.permissions.request({ origins: patterns });
    } catch {
      return false;
    }
  },
};
