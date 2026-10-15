import { createShadowHost } from './shadow';
import { logOnce, safe } from './safe';

/**
 * Floating "Tracking history" button in Gmail's bottom-left corner. It opens the toolbar popup's
 * own page (`popup.html?embed=1`) in an iframe, so the in-Gmail panel is exactly the popup UI and
 * talks to the service worker as an extension page. Pure DOM; doesn't depend on InboxSDK.
 */

export const OPEN_THREAD_MSG = 'postmark:open-thread';

export interface LauncherDeps {
  /** The account active in this tab, once known (used to open threads in place). */
  getAccount: () => string | null;
}

const CSS = `
:host { all: initial; }
.btn {
  position: fixed; left: 16px; bottom: 16px; z-index: 2147483000;
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; border-radius: 999px; cursor: pointer;
  font: 500 13px/1 'Google Sans', Roboto, system-ui, sans-serif;
  color: #2b4c7e; background: #ffffff; border: 1px solid #d9e1ec;
  box-shadow: 0 1px 3px rgba(0,0,0,.15);
}
.btn:hover { background: #f4f7fb; }
.btn:focus-visible { outline: 2px solid #2b6cb0; outline-offset: 2px; }
.btn img { width: 16px; height: 16px; }
.panel {
  position: fixed; left: 16px; bottom: 60px; z-index: 2147483000;
  width: 400px; height: 600px; max-height: calc(100vh - 80px);
  border: 1px solid #d9e1ec; border-radius: 10px; overflow: hidden;
  background: #ffffff; box-shadow: 0 8px 28px rgba(0,0,0,.22);
}
.panel[hidden] { display: none; }
iframe { width: 100%; height: 100%; border: 0; display: block; }
:host([data-theme='dark']) .btn { color: #9db7e8; background: #1f2633; border-color: #39445a; }
:host([data-theme='dark']) .btn:hover { background: #283043; }
:host([data-theme='dark']) .panel { background: #161b24; border-color: #39445a; }
`;

export function startHistoryLauncher(deps: LauncherDeps, doc: Document = document): () => void {
  const { host, mount } = createShadowHost(CSS);
  host.id = 'postmark-history-launcher';

  const btn = doc.createElement('button');
  btn.className = 'btn';
  btn.type = 'button';
  btn.title = 'Postmark tracking history';
  btn.setAttribute('aria-label', 'Open Postmark tracking history');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'pm-history-panel');
  const icon = doc.createElement('img');
  icon.src = chrome.runtime.getURL('icons/icon-32.png');
  icon.alt = '';
  btn.append(icon, doc.createTextNode('Tracking'));

  const panel = doc.createElement('div');
  panel.className = 'panel';
  panel.id = 'pm-history-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Postmark tracking history');
  panel.hidden = true;

  let frame: HTMLIFrameElement | null = null;

  const setOpen = (open: boolean) => {
    if (open) {
      // Fresh iframe per open so the list is current, like reopening the toolbar popup.
      frame?.remove();
      frame = doc.createElement('iframe');
      frame.title = 'Postmark tracking history';
      frame.src = chrome.runtime.getURL('popup.html?embed=1');
      panel.append(frame);
    }
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  const isOpen = () => !panel.hidden;

  btn.addEventListener(
    'click',
    safe('history launcher toggle', () => setOpen(!isOpen())),
  );

  // Close on Escape or a click elsewhere in Gmail (clicks inside the iframe never reach us).
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isOpen()) {
      setOpen(false);
      btn.focus();
    }
  };
  const onDown = (e: MouseEvent) => {
    if (isOpen() && !e.composedPath().includes(host)) setOpen(false);
  };

  // "Open in Gmail" from the embedded panel: navigate this tab instead of opening a new one.
  const onMessage = safe('history launcher message', (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const data = e.data as { type?: unknown; threadId?: unknown; account?: unknown } | null;
    if (data?.type !== OPEN_THREAD_MSG || typeof data.threadId !== 'string') return;
    const account = typeof data.account === 'string' ? data.account : null;
    const hash = `#all/${encodeURIComponent(data.threadId)}`;
    const here = deps.getAccount();
    if (!account || (here && account.toLowerCase() === here.toLowerCase())) {
      doc.defaultView!.location.hash = hash;
    } else {
      doc.defaultView!.open(
        `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}${hash}`,
        '_blank',
        'noopener',
      );
    }
    setOpen(false);
  });

  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('mousedown', onDown, true);
  doc.defaultView?.addEventListener('message', onMessage);

  mount.append(panel, btn);
  try {
    doc.body.append(host);
  } catch (err) {
    logOnce('could not add the tracking history button', err);
  }

  return () => {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('mousedown', onDown, true);
    doc.defaultView?.removeEventListener('message', onMessage);
    host.remove();
  };
}
