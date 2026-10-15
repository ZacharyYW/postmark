import { render } from 'preact';
import '../styles/tokens.css';
import { OPEN_THREAD_MSG } from '../../gmail/historyLauncher';
import { Popup } from './Popup';

// `?embed=1`: rendered inside Gmail's in-page history panel rather than the toolbar popup.
const embedded = new URLSearchParams(location.search).has('embed');
if (embedded) document.documentElement.classList.add('pm-embed');

render(
  <Popup
    onOpenOptions={() => void chrome.runtime.openOptionsPage()}
    onOpenThread={
      embedded
        ? (threadId, account) =>
            window.parent.postMessage(
              { type: OPEN_THREAD_MSG, threadId, account },
              'https://mail.google.com',
            )
        : undefined
    }
  />,
  document.getElementById('app')!,
);
