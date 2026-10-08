import type { MessageSummary } from '@postmark/shared';
import { statusView } from '../format';
import s from './StatusBadge.module.css';

/** Double check mark (✓✓); color comes from the tone class. */
export function Ticks() {
  return (
    <svg class={s.icon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8.5l2.6 2.6L9 5.5"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M7.2 10.4l.7.7L14.5 5.5"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function StatusBadge({ message }: { message: MessageSummary }) {
  const v = statusView(message);
  return (
    <span class={`${s.badge} ${s[v.tone] ?? ''}`} title={v.detail}>
      <Ticks />
      <span>{v.label}</span>
      <span class="sr-only">. {v.detail}</span>
    </span>
  );
}
