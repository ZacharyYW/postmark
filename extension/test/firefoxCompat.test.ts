import { describe, expect, it } from 'vitest';
import { exposeExtensionApiOnWindow } from '../src/gmail/firefoxCompat';

describe('exposeExtensionApiOnWindow', () => {
  const api = { runtime: { sendMessage: () => undefined } };

  it('Firefox: puts the extension API on the (Xray) window so InboxSDK can reach it', () => {
    const xrayWindow: { chrome?: unknown } = {};
    exposeExtensionApiOnWindow(xrayWindow, api);
    expect(xrayWindow.chrome).toBe(api);
  });

  it('Chrome: leaves an existing window.chrome alone', () => {
    const own = { runtime: { id: 'x' } };
    const win = { chrome: own };
    exposeExtensionApiOnWindow(win, api);
    expect(win.chrome).toBe(own);
  });

  it('does nothing without an extension API (e.g. stale script after an extension reload)', () => {
    const win: { chrome?: unknown } = {};
    exposeExtensionApiOnWindow(win, null);
    expect(win.chrome).toBeUndefined();
  });
});
