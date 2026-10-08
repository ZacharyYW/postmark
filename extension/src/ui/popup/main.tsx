import { render } from 'preact';
import '../styles/tokens.css';
import { Popup } from './Popup';

render(
  <Popup onOpenOptions={() => void chrome.runtime.openOptionsPage()} />,
  document.getElementById('app')!,
);
