/**
 * Privacy guard: InboxSDK reports errors and usage events (with a hashed user email and the
 * extension id) to Streak's servers. Postmark promises no third-party calls, so inside *our*
 * content-script world (isolated per extension, so other InboxSDK-based extensions are
 * unaffected) we refuse those requests locally. Nothing is sent over the network.
 *
 * Blocked requests are answered *locally* with a harmless "200 OK" (an empty JSON object, or a
 * long-lived dummy token for InboxSDK's events-token endpoint). InboxSDK treats its telemetry as
 * delivered and stays quiet; an error response instead makes it log noisy errors and retry.
 */

export const BLOCKED_HOSTS: readonly string[] = ['api.inboxsdk.com', 'pubsub.googleapis.com'];

/** The local stand-in response for a blocked telemetry URL. */
export function fakeResponseBody(url: string, now = Date.now()): string {
  if (/\/events\/oauth/.test(url)) {
    return JSON.stringify({
      oauthToken: 'blocked-by-postmark',
      expirationDate: now + 365 * 86_400_000,
    });
  }
  return '{}';
}

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

type FetchHost = { XMLHttpRequest: typeof XMLHttpRequest; fetch: typeof fetch };

/**
 * Where the guard must be installed. In Chrome the content script's `window` *is* its global.
 * In a Firefox content script they differ: the global is a sandbox, and `window` is an Xray
 * view of Gmail's window. InboxSDK reads `window.XMLHttpRequest` explicitly, while bare `fetch`
 * resolves on the sandbox, so both are patched. Assignments to the Xray are expandos that only
 * our content script sees; Gmail's own scripts are unaffected.
 */
function contentScriptGlobals(): FetchHost[] {
  const out: FetchHost[] = [globalThis];
  if (typeof window !== 'undefined' && (window as unknown) !== globalThis) out.push(window);
  return out;
}

export function installTelemetryGuard(
  win: Window & typeof globalThis = globalThis as Window & typeof globalThis,
  targets: FetchHost[] = contentScriptGlobals(),
): void {
  if (installed) return;
  installed = true;

  const OrigXHR = win.XMLHttpRequest;
  class GuardedXHR extends OrigXHR {
    private pmBlocked = false;
    private pmUrl = '';
    private pmDone = false;
    override open(method: string, url: string | URL, ...rest: unknown[]): void {
      this.pmUrl = String(url);
      this.pmBlocked = isBlockedUrl(this.pmUrl);
      this.pmDone = false;
      if (this.pmBlocked) {
        blockedLog.push(this.pmUrl.split('?')[0] ?? '');
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
      // Nothing goes over the network; answer locally.
      setTimeout(() => {
        this.pmDone = true;
        this.dispatchEvent(new Event('readystatechange'));
        this.dispatchEvent(new ProgressEvent('load'));
        this.dispatchEvent(new ProgressEvent('loadend'));
      }, 0);
    }
    override get status(): number {
      return this.pmBlocked ? (this.pmDone ? 200 : 0) : super.status;
    }
    override get readyState(): number {
      return this.pmBlocked ? (this.pmDone ? 4 : 1) : super.readyState;
    }
    override get responseText(): string {
      return this.pmBlocked
        ? this.pmDone
          ? fakeResponseBody(this.pmUrl)
          : ''
        : super.responseText;
    }
    override get response(): unknown {
      return this.pmBlocked ? this.responseText : super.response;
    }
  }
  const origFetch = win.fetch?.bind(win);
  const guardedFetch =
    origFetch &&
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isBlockedUrl(url)) {
        blockedLog.push(url.split('?')[0] ?? '');
        return Promise.resolve(
          new Response(fakeResponseBody(url), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return origFetch(input, init);
    });
  for (const t of targets) {
    t.XMLHttpRequest = GuardedXHR;
    if (guardedFetch) t.fetch = guardedFetch;
  }
}
