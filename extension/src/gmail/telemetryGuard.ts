/**
 * Privacy guard: InboxSDK reports errors and usage events (with a hashed user email and the
 * extension id) to Streak's servers. Postmark promises no third-party calls, so inside *our*
 * content-script world (isolated per extension, so other InboxSDK-based extensions are
 * unaffected) we refuse those requests locally. Nothing is sent over the network.
 *
 * Blocked requests answer with status 490, which InboxSDK treats as "server told us to go
 * away": it stops contacting that host for the rest of the session instead of retrying.
 */

export const BLOCKED_HOSTS: readonly string[] = ['api.inboxsdk.com', 'pubsub.googleapis.com'];
export const BLOCKED_STATUS = 490;

export function isBlockedUrl(raw: string, base = 'https://mail.google.com/'): boolean {
  try {
    const host = new URL(raw, base).hostname.toLowerCase();
    return BLOCKED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

let installed = false;
export const blockedLog: string[] = [];

export function installTelemetryGuard(win: Window & typeof globalThis = window): void {
  if (installed) return;
  installed = true;

  const OrigXHR = win.XMLHttpRequest;
  class GuardedXHR extends OrigXHR {
    private pmBlocked = false;
    override open(method: string, url: string | URL, ...rest: unknown[]): void {
      this.pmBlocked = isBlockedUrl(String(url));
      if (this.pmBlocked) {
        blockedLog.push(String(url).split('?')[0] ?? '');
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarding XHR's overloads
      (OrigXHR.prototype.open as any).call(this, method, url, ...rest);
    }
    override setRequestHeader(name: string, value: string): void {
      if (!this.pmBlocked) super.setRequestHeader(name, value);
    }
    override send(body?: Document | XMLHttpRequestBodyInit | null): void {
      if (!this.pmBlocked) {
        super.send(body);
        return;
      }
      setTimeout(() => {
        this.dispatchEvent(new ProgressEvent('error'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      }, 0);
    }
    override get status(): number {
      return this.pmBlocked ? BLOCKED_STATUS : super.status;
    }
  }
  win.XMLHttpRequest = GuardedXHR;

  const origFetch = win.fetch?.bind(win);
  if (origFetch) {
    win.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isBlockedUrl(url)) {
        blockedLog.push(url.split('?')[0] ?? '');
        return Promise.reject(new TypeError('Blocked by Postmark privacy guard'));
      }
      return origFetch(input, init);
    };
  }
}
