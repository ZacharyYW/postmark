import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  absoluteTime,
  type BusError,
  type MessageSummary,
  type TrackingEvent,
} from '@postmark/shared';
import { useBus } from '../busContext';
import { ActivityTimeline } from '../components/ActivityTimeline';
import { StatusBadge } from '../components/StatusBadge';
import { shortUrl } from '../format';
import s from './Popup.module.css';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; message: MessageSummary; events: TrackingEvent[] }
  | { kind: 'error'; error: BusError };

const cls = (n: string) => s[n] ?? n;

/** Full history of one tracked email. */
export function MessageDetail({
  message: initial,
  showAccount,
  onBack,
}: {
  message: MessageSummary;
  showAccount: boolean;
  onBack: () => void;
}) {
  const bus = useBus();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const r = await bus.send('GET_MESSAGE_EVENTS', { messageId: initial.id });
    setState(r.ok ? { kind: 'ready', ...r.data } : { kind: 'error', error: r.error });
  }, [bus, initial.id]);

  useEffect(() => void load(), [load]);

  const m = state.kind === 'ready' ? state.message : initial;

  return (
    <section class={s.detail} aria-label="Email details">
      <div class={s.detailBar}>
        <button class={s.linkBtn} onClick={onBack}>
          ← Back
        </button>
        {m.gmailThreadId ? (
          <button
            class={s.primarySmall}
            onClick={() =>
              void bus.send('OPEN_THREAD', {
                gmailThreadId: m.gmailThreadId ?? '',
                account: m.senderAccount,
              })
            }
          >
            Open in Gmail
          </button>
        ) : (
          <span class={s.muted} title="Gmail hasn't confirmed this send yet">
            Not linked to Gmail yet
          </span>
        )}
      </div>
      <h2 class={s.detailTitle}>{m.subject || '(no subject)'}</h2>
      <dl class={s.facts}>
        <dt>To</dt>
        <dd>{m.recipients.join(', ') || '—'}</dd>
        {showAccount && (
          <>
            <dt>From</dt>
            <dd>{m.senderAccount}</dd>
          </>
        )}
        <dt>Sent</dt>
        <dd>{absoluteTime(m.sentAt)}</dd>
        <dt>Status</dt>
        <dd>
          <StatusBadge message={m} />
        </dd>
        <dt>Opens</dt>
        <dd>
          {m.opens.total}
          {m.opens.autoLoaded > 0 && ` (+${m.opens.autoLoaded} possibly auto-loaded)`}
        </dd>
        {m.links.length > 0 && (
          <>
            <dt>Clicks</dt>
            <dd>
              <ul class={s.linkList}>
                {m.links.map((l) => (
                  <li key={l.id} title={l.originalUrl}>
                    {shortUrl(l.originalUrl)}: {l.clicks}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      <h3 class={s.sectionTitle}>Activity</h3>
      {state.kind === 'loading' ? (
        <p class={s.muted} role="status">
          Loading activity…
        </p>
      ) : state.kind === 'error' ? (
        <div role="alert">
          <p class={s.muted}>Couldn’t load activity: {state.error.message}</p>
          <button class={s.linkBtn} onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : (
        <ActivityTimeline events={state.events} recipients={m.recipients} cls={cls} />
      )}
    </section>
  );
}
