import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  absoluteTime,
  accountChipLabel,
  untilTime,
  type AccountInfo,
  type BusError,
  type MessageSummary,
  type Reminder,
} from '@postmark/shared';
import { useBus, usePrefs } from '../busContext';
import { StatusBadge } from '../components/StatusBadge';
import { lastEventLabel, recipientsLabel } from '../format';
import { MessageDetail } from './MessageDetail';
import s from './Popup.module.css';

type Tab = 'recent' | 'reminders';
type Load<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T }
  | { kind: 'error'; error: BusError };

export const ALL = '__all__';

const CONDITION_TEXT: Record<Reminder['condition'], string> = {
  no_open: 'if not opened',
  no_reply: 'if no reply',
  always: 'always',
};

function isOffline(e: BusError) {
  return e.code === 'NETWORK' || e.code === 'TIMEOUT';
}

export function Popup({ onOpenOptions }: { onOpenOptions: () => void }) {
  const bus = useBus();
  const prefs = usePrefs();
  const [auth, setAuth] = useState<{ loggedIn: boolean; serverUrl: string } | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [account, setAccount] = useState<string>(ALL);
  const [tab, setTab] = useState<Tab>('recent');
  const [q, setQ] = useState('');
  const [messages, setMessages] = useState<Load<MessageSummary[]>>({ kind: 'loading' });
  const [reminders, setReminders] = useState<Load<Reminder[]>>({ kind: 'loading' });
  const [booted, setBooted] = useState(false);
  const [selected, setSelected] = useState<MessageSummary | null>(null);

  // Boot: auth → accounts → preselect the active Gmail tab's account (else last selection, else All).
  useEffect(() => {
    void (async () => {
      const a = await bus.send('GET_AUTH_STATE', {});
      if (!a.ok) {
        setAuth({ loggedIn: false, serverUrl: '' });
        setMessages({ kind: 'error', error: a.error });
        setBooted(true);
        return;
      }
      setAuth(a.data);
      if (!a.data.loggedIn) {
        setBooted(true);
        return;
      }
      const [acc, active, last] = await Promise.all([
        bus.send('LIST_ACCOUNTS', {}),
        bus.send('GET_ACTIVE_TAB_ACCOUNT', {}),
        prefs.get<string>('popupAccount'),
      ]);
      const list = acc.ok ? acc.data.accounts : [];
      setAccounts(list);
      const names = new Set(list.map((x) => x.account));
      const activeAcct = active.ok ? active.data.account : null;
      if (activeAcct && names.has(activeAcct)) setAccount(activeAcct);
      else if (last && (last === ALL || names.has(last))) setAccount(last);
      setBooted(true);
    })();
  }, [bus, prefs]);

  const acctParam = account === ALL ? null : account;

  const loadMessages = useCallback(async () => {
    setMessages({ kind: 'loading' });
    const r = await bus.send('LIST_MESSAGES', { account: acctParam, limit: 50, q });
    setMessages(
      r.ok ? { kind: 'ready', data: r.data.messages } : { kind: 'error', error: r.error },
    );
  }, [bus, acctParam, q]);

  const loadReminders = useCallback(async () => {
    setReminders({ kind: 'loading' });
    const r = await bus.send('LIST_REMINDERS', { account: acctParam });
    setReminders(
      r.ok ? { kind: 'ready', data: r.data.reminders } : { kind: 'error', error: r.error },
    );
  }, [bus, acctParam]);

  useEffect(() => {
    if (!booted || !auth?.loggedIn) return;
    const t = setTimeout(
      () => void (tab === 'recent' ? loadMessages() : loadReminders()),
      q ? 200 : 0,
    );
    return () => clearTimeout(t);
  }, [booted, auth, tab, loadMessages, loadReminders, q]);

  const chooseAccount = (v: string) => {
    setAccount(v);
    void prefs.set('popupAccount', v);
  };

  const showChips = account === ALL && accounts.length > 1;

  const header = (
    <header class={s.header}>
      <div class={s.brand}>
        <img src="/icons/icon-32.png" alt="" />
        Postmark
      </div>
      <span class={s.spacer} />
      {auth?.loggedIn && (
        <label>
          <span class="sr-only">Gmail account</span>
          <select
            class={s.select}
            value={account}
            onChange={(e) => chooseAccount((e.target as HTMLSelectElement).value)}
            aria-label="Gmail account"
          >
            <option value={ALL}>All accounts</option>
            {accounts.map((a) => (
              <option value={a.account} key={a.account}>
                {a.account}
              </option>
            ))}
          </select>
        </label>
      )}
      <button class={s.iconBtn} onClick={onOpenOptions} aria-label="Settings" title="Settings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm7.4-2.5l1.8 1.4-1.8 3.1-2.1-.8a7.6 7.6 0 01-1.9 1.1L15 20h-3.6l-.4-2.2a7.6 7.6 0 01-1.9-1.1l-2.1.8-1.8-3.1L7 13a7.7 7.7 0 010-2.1L5.2 9.5 7 6.4l2.1.8A7.6 7.6 0 0111 6.1L11.4 4H15l.4 2.1c.7.3 1.3.7 1.9 1.1l2.1-.8 1.8 3.1-1.8 1.4c.1.7.1 1.4 0 2.1z"
            stroke="currentColor"
            stroke-width="1.5"
          />
        </svg>
      </button>
    </header>
  );

  if (!auth) {
    return (
      <div class={s.app}>
        {header}
        <Skeletons />
      </div>
    );
  }

  if (!auth.loggedIn) {
    return (
      <div class={s.app}>
        {header}
        <div class={s.state} data-state="logged-out">
          <h2>Sign in to Postmark</h2>
          <p>Connect the extension to your Postmark server to start tracking opens and clicks.</p>
          <button class={s.primary} onClick={onOpenOptions}>
            Open settings
          </button>
        </div>
      </div>
    );
  }

  if (selected) {
    return (
      <div class={s.app}>
        {header}
        <MessageDetail
          message={selected}
          showAccount={accounts.length > 1}
          onBack={() => setSelected(null)}
        />
      </div>
    );
  }

  return (
    <div class={s.app}>
      {header}
      <div class={s.tabs} role="tablist" aria-label="Views">
        <button
          role="tab"
          class={s.tab}
          aria-selected={tab === 'recent'}
          onClick={() => setTab('recent')}
        >
          Recent
        </button>
        <button
          role="tab"
          class={s.tab}
          aria-selected={tab === 'reminders'}
          onClick={() => setTab('reminders')}
        >
          Reminders
        </button>
      </div>
      {tab === 'recent' ? (
        <>
          <div class={s.search}>
            <input
              type="search"
              placeholder="Search recipient or subject"
              aria-label="Search recipient or subject"
              value={q}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            />
          </div>
          <RecentList
            state={messages}
            showChips={showChips}
            query={q}
            onRetry={loadMessages}
            serverUrl={auth.serverUrl}
            onSelect={setSelected}
          />
        </>
      ) : (
        <ReminderList
          state={reminders}
          showChips={showChips}
          onRetry={loadReminders}
          serverUrl={auth.serverUrl}
        />
      )}
      <footer class={s.footer}>Open tracking is an estimate, never proof of reading.</footer>
    </div>
  );
}

function Skeletons() {
  return (
    <div aria-busy="true" aria-label="Loading" data-state="loading">
      {[0, 1, 2, 3].map((i) => (
        <div class={s.skeleton} key={i} />
      ))}
    </div>
  );
}

function ErrorState({
  error,
  onRetry,
  serverUrl,
}: {
  error: BusError;
  onRetry: () => void;
  serverUrl: string;
}) {
  const offline = isOffline(error);
  return (
    <div class={s.state} role="alert" data-state={offline ? 'offline' : 'error'}>
      <h2>{offline ? 'Can’t reach your Postmark server' : 'Something went wrong'}</h2>
      <p>
        {offline ? `Is the server at ${serverUrl} running? Check your connection.` : error.message}
      </p>
      <button class={s.primary} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function RecentList({
  state,
  showChips,
  query,
  onRetry,
  serverUrl,
  onSelect,
}: {
  state: Load<MessageSummary[]>;
  showChips: boolean;
  query: string;
  onRetry: () => void;
  serverUrl: string;
  onSelect: (m: MessageSummary) => void;
}) {
  if (state.kind === 'loading') return <Skeletons />;
  if (state.kind === 'error')
    return <ErrorState error={state.error} onRetry={onRetry} serverUrl={serverUrl} />;
  if (state.data.length === 0) {
    return (
      <div class={s.state} data-state="empty">
        <h2>{query ? 'No matches' : 'No tracked emails yet'}</h2>
        <p>
          {query
            ? 'Try a different recipient or subject.'
            : 'Compose an email in Gmail with the Postmark eye icon on, and it will show up here.'}
        </p>
      </div>
    );
  }
  return (
    <ul class={s.list} aria-label="Tracked emails">
      {state.data.map((m) => {
        const last = lastEventLabel(m);
        return (
          <li key={m.id}>
            <button
              class={s.row}
              title="Show full activity"
              aria-label={`${recipientsLabel(m.recipients)}: ${m.subject || '(no subject)'}. Show details`}
              onClick={() => onSelect(m)}
            >
              <span class={s.to}>{recipientsLabel(m.recipients)}</span>
              <span class={s.meta}>
                <StatusBadge message={m} />
              </span>
              <span class={s.subject}>{m.subject || '(no subject)'}</span>
              <span class={s.time} title={last.title}>
                {last.text}
              </span>
              {showChips && (
                <span class={s.chipLine}>
                  <span class={s.chip} title={`Sent from ${m.senderAccount}`}>
                    via {accountChipLabel(m.senderAccount)}
                  </span>
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ReminderList({
  state,
  showChips,
  onRetry,
  serverUrl,
}: {
  state: Load<Reminder[]>;
  showChips: boolean;
  onRetry: () => void;
  serverUrl: string;
}) {
  const bus = useBus();
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const items = useMemo(
    () => (state.kind === 'ready' ? state.data.filter((r) => !removed.has(r.id)) : []),
    [state, removed],
  );
  if (state.kind === 'loading') return <Skeletons />;
  if (state.kind === 'error')
    return <ErrorState error={state.error} onRetry={onRetry} serverUrl={serverUrl} />;
  if (items.length === 0) {
    return (
      <div class={s.state} data-state="empty">
        <h2>No reminders</h2>
        <p>Open a tracked email in Gmail and use “Remind me” in its tracking strip.</p>
      </div>
    );
  }
  return (
    <ul class={s.list} aria-label="Reminders">
      {items.map((r) => (
        <li class={s.remRow} key={r.id}>
          <span class={s.to}>{r.subject || '(no subject)'}</span>
          <button
            class={s.danger}
            aria-label={`Delete reminder for ${r.subject || 'email'}`}
            onClick={async () => {
              const res = await bus.send('DELETE_REMINDER', { id: r.id });
              if (res.ok) setRemoved(new Set([...removed, r.id]));
            }}
          >
            Delete
          </button>
          <span class={s.subject}>
            {recipientsLabel(r.recipients)} · {CONDITION_TEXT[r.condition]}
            {showChips && <> · {accountChipLabel(r.senderAccount)}</>}
          </span>
          <span class={s.time} title={absoluteTime(r.remindAt)}>
            {untilTime(r.remindAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
