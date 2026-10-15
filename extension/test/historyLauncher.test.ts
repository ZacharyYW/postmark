import { afterEach, describe, expect, it } from 'vitest';
import { OPEN_THREAD_MSG, startHistoryLauncher } from '../src/gmail/historyLauncher';

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  location.hash = '';
});

function setup(account: string | null = 'me@x.com') {
  stop = startHistoryLauncher({ getAccount: () => account });
  const root = document.getElementById('postmark-history-launcher')!.shadowRoot!;
  const btn = root.querySelector('button')!;
  const panel = root.querySelector<HTMLElement>('.panel')!;
  return { root, btn, panel };
}

describe('history launcher', () => {
  it('toggles a panel embedding the popup page', () => {
    const { root, btn, panel } = setup();
    expect(panel.hidden).toBe(true);
    btn.click();
    expect(panel.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('iframe')!.src).toMatch(
      /^chrome-extension:\/\/.+\/popup\.html\?embed=1$/,
    );
    btn.click();
    expect(panel.hidden).toBe(true);
  });

  it('closes on Escape and on an outside click', () => {
    const { btn, panel } = setup();
    btn.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.hidden).toBe(true);
    btn.click();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    expect(panel.hidden).toBe(true);
  });

  it('opens a same-account thread in place, ignoring messages from other sources', () => {
    const { root, btn, panel } = setup('me@x.com');
    btn.click();
    const frame = root.querySelector('iframe')!;
    const msg = { type: OPEN_THREAD_MSG, threadId: 't1', account: 'Me@x.com' };
    window.dispatchEvent(new MessageEvent('message', { data: msg, source: window }));
    expect(location.hash).toBe('');
    window.dispatchEvent(new MessageEvent('message', { data: msg, source: frame.contentWindow }));
    expect(location.hash).toBe('#all/t1');
    expect(panel.hidden).toBe(true);
  });
});
