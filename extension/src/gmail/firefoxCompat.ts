/**
 * Firefox content scripts: `window` is an Xray view of Gmail's window, and the extension API
 * (`chrome` / `browser`) exists only on the content-script global. InboxSDK asks the background
 * to inject its page-world script via `window.chrome.runtime.sendMessage`; without the API on
 * `window` that throws and InboxSDK never loads (no compose button, marks or strip).
 *
 * The assignment lands as an expando on the Xray, which only our content script can see; Gmail's
 * own scripts never get the extension API. No-op in Chrome, where `window.chrome.runtime` exists.
 */
export function exposeExtensionApiOnWindow(win: object = window, api: unknown = globalThis.chrome) {
  const w = win as { chrome?: { runtime?: unknown } };
  if (w.chrome?.runtime) return;
  if (!(api as { runtime?: unknown } | undefined)?.runtime) return;
  w.chrome = api as { runtime?: unknown };
}
