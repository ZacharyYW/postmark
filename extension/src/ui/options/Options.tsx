import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AccountInfo, GlobalSettings, QuietHours } from '@postmark/shared';
import { useBus } from '../busContext';
import s from './Options.module.css';

type Msg = { kind: 'ok' | 'err'; text: string } | null;

function Note({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <div
      class={`${s.msg} ${msg.kind === 'ok' ? s.ok : s.err}`}
      role={msg.kind === 'err' ? 'alert' : 'status'}
    >
      {msg.text}
    </div>
  );
}

export interface OptionsProps {
  /** Ask Chrome for host permission to a custom server origin (must run in a user gesture). */
  requestHostPermission?: (origin: string) => Promise<boolean>;
}

const defaultRequest = async (origin: string) => {
  try {
    const pattern = `${new URL(origin).protocol}//${new URL(origin).hostname}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
};

export function Options({ requestHostPermission = defaultRequest }: OptionsProps) {
  const bus = useBus();
  const [auth, setAuth] = useState<{
    loggedIn: boolean;
    email: string | null;
    serverUrl: string;
  } | null>(null);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [accountsErr, setAccountsErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [a, g] = await Promise.all([
      bus.send('GET_AUTH_STATE', {}),
      bus.send('GET_SETTINGS', {}),
    ]);
    if (a.ok) setAuth(a.data);
    if (g.ok) setSettings(g.data.global);
    if (a.ok && a.data.loggedIn) {
      const acc = await bus.send('LIST_ACCOUNTS', {});
      if (acc.ok) {
        setAccounts(acc.data.accounts);
        setAccountsErr(null);
      } else {
        setAccounts([]);
        setAccountsErr(acc.error.message);
      }
    } else {
      setAccounts(null);
    }
  }, [bus]);

  useEffect(() => void refresh(), [refresh]);

  const update = async (patch: Partial<GlobalSettings>) => {
    const r = await bus.send('UPDATE_GLOBAL_SETTINGS', patch);
    if (r.ok) setSettings(r.data);
  };

  return (
    <main class={s.page}>
      <div class={s.top}>
        <img src="/icons/icon-48.png" alt="" />
        <div>
          <h1>Postmark settings</h1>
          <p>Read receipts and link tracking for Gmail, on your own server.</p>
        </div>
      </div>

      {auth && (
        <ConnectionCard
          auth={auth}
          onChange={refresh}
          requestHostPermission={requestHostPermission}
        />
      )}

      {auth?.loggedIn && (
        <AccountsCard accounts={accounts} error={accountsErr} onChange={refresh} />
      )}

      {settings && (
        <>
          <section class={s.card} aria-labelledby="defaults-h">
            <h2 id="defaults-h">Tracking defaults</h2>
            <p>Applies to every Gmail account unless overridden above.</p>
            <Check
              label="Track new emails by default"
              hint="You can always switch tracking off for one email with the eye icon in the compose toolbar."
              checked={settings.trackingDefault}
              onChange={(v) => update({ trackingDefault: v })}
            />
            <Check
              label="Add a disclosure line to tracked emails"
              hint={
                'Appends a small grey line, “Read receipts enabled (Postmark)”, so recipients know.'
              }
              checked={settings.disclosureFooter}
              onChange={(v) => update({ disclosureFooter: v })}
            />
          </section>

          <section class={s.card} aria-labelledby="notif-h">
            <h2 id="notif-h">Notifications</h2>
            <p>Desktop notifications from Chrome. Per-account switches above take precedence.</p>
            <Check
              label="First open of an email"
              checked={settings.notifyFirstOpen}
              onChange={(v) => update({ notifyFirstOpen: v })}
            />
            <Check
              label="Link clicks"
              checked={settings.notifyClick}
              onChange={(v) => update({ notifyClick: v })}
            />
            <Check
              label="Follow-up reminders"
              checked={settings.notifyReminders}
              onChange={(v) => update({ notifyReminders: v })}
            />
            <QuietHoursField
              value={settings.quietHours}
              onChange={(q) => update({ quietHours: q })}
            />
          </section>
        </>
      )}

      <PrivacyCard />
    </main>
  );
}

function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label class={s.check}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

function QuietHoursField({
  value,
  onChange,
}: {
  value: QuietHours | null;
  onChange: (q: QuietHours | null) => void;
}) {
  const [start, setStart] = useState(value?.start ?? '22:00');
  const [end, setEnd] = useState(value?.end ?? '07:00');
  const enabled = value !== null;
  return (
    <div>
      <Check
        label="Quiet hours"
        hint="Notifications are held and summarised when quiet hours end."
        checked={enabled}
        onChange={(v) => onChange(v ? { start, end } : null)}
      />
      {enabled && (
        <div class={s.inline}>
          <label>
            From{' '}
            <input
              class={`${s.input} ${s.small}`}
              type="time"
              value={start}
              aria-label="Quiet hours start"
              onChange={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setStart(v);
                onChange({ start: v, end });
              }}
            />
          </label>
          <label>
            to{' '}
            <input
              class={`${s.input} ${s.small}`}
              type="time"
              value={end}
              aria-label="Quiet hours end"
              onChange={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setEnd(v);
                onChange({ start, end: v });
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function ConnectionCard({
  auth,
  onChange,
  requestHostPermission,
}: {
  auth: { loggedIn: boolean; email: string | null; serverUrl: string };
  onChange: () => Promise<void>;
  requestHostPermission: (origin: string) => Promise<boolean>;
}) {
  const bus = useBus();
  const [server, setServer] = useState(auth.serverUrl);
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => setServer(auth.serverUrl), [auth.serverUrl]);

  const ensureServer = async (): Promise<string | null> => {
    const trimmed = server.trim();
    if (!(await requestHostPermission(trimmed))) {
      setMsg({ kind: 'err', text: 'Chrome permission to contact that server was not granted.' });
      return null;
    }
    return trimmed;
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class={s.card} aria-labelledby="conn-h">
      <h2 id="conn-h">Postmark account</h2>
      <p>
        {auth.loggedIn
          ? `Signed in as ${auth.email || 'your Postmark account'} on ${auth.serverUrl}.`
          : 'Not signed in. Tracking is off until you connect.'}
      </p>

      <div class={s.field}>
        <label for="server">Server URL</label>
        <div class={s.inline}>
          <input
            id="server"
            class={s.input}
            type="url"
            value={server}
            onInput={(e) => setServer((e.target as HTMLInputElement).value)}
          />
          <button
            class={s.btn}
            disabled={busy}
            onClick={() =>
              run(async () => {
                const url = await ensureServer();
                if (!url) return;
                const r = await bus.send('SET_SERVER_URL', { serverUrl: url });
                setMsg(
                  r.ok
                    ? { kind: 'ok', text: `Server set to ${r.data.serverUrl}.` }
                    : { kind: 'err', text: r.error.message },
                );
                await onChange();
              })
            }
          >
            Save server
          </button>
        </div>
      </div>

      {!auth.loggedIn ? (
        <>
          <form
            class={s.field}
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const url = await ensureServer();
                if (!url) return;
                const r = await bus.send('REGISTER', { email, serverUrl: url });
                setMsg(
                  r.ok
                    ? { kind: 'ok', text: `Registered ${r.data.email}.` }
                    : { kind: 'err', text: r.error.message },
                );
                await onChange();
              });
            }}
          >
            <label for="email">Email for your Postmark account</label>
            <div class={s.inline}>
              <input
                id="email"
                class={s.input}
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
              />
              <button class={`${s.btn} ${s.primary}`} type="submit" disabled={busy}>
                Register
              </button>
            </div>
          </form>
          <details>
            <summary>Connect with an existing token</summary>
            <form
              class={s.field}
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const url = await ensureServer();
                  if (!url) return;
                  const r = await bus.send('CONNECT_TOKEN', { token, serverUrl: url });
                  setMsg(
                    r.ok
                      ? { kind: 'ok', text: `Connected as ${r.data.email}.` }
                      : { kind: 'err', text: r.error.message },
                  );
                  setToken('');
                  await onChange();
                });
              }}
            >
              <label for="token">
                Token (e.g. printed by <code>npm run seed</code>)
              </label>
              <div class={s.inline}>
                <input
                  id="token"
                  class={s.input}
                  type="password"
                  autocomplete="off"
                  value={token}
                  onInput={(e) => setToken((e.target as HTMLInputElement).value)}
                />
                <button class={s.btn} type="submit" disabled={busy || !token}>
                  Connect
                </button>
              </div>
            </form>
          </details>
        </>
      ) : (
        <div class={s.inline}>
          <button
            class={s.btn}
            disabled={busy}
            onClick={() =>
              run(async () => {
                await bus.send('LOGOUT', {});
                setMsg({ kind: 'ok', text: 'Signed out.' });
                await onChange();
              })
            }
          >
            Sign out
          </button>
          <button
            class={`${s.btn} ${s.danger}`}
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete my data…
          </button>
        </div>
      )}

      {confirmDelete && (
        <div class={s.confirm} role="alertdialog" aria-labelledby="del-h">
          <strong id="del-h">Permanently delete all your Postmark data?</strong>
          <p class={s.muted}>
            This erases your account, every tracked message, event and reminder from the server.
            Emails you already sent keep their (now inactive) tracking links, which will show “link
            not available”.
          </p>
          <div class={s.inline}>
            <button
              class={`${s.btn} ${s.dangerFill}`}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await bus.send('DELETE_ME', {});
                  setConfirmDelete(false);
                  setMsg(
                    r.ok
                      ? { kind: 'ok', text: 'All your data was deleted.' }
                      : { kind: 'err', text: r.error.message },
                  );
                  await onChange();
                })
              }
            >
              Yes, delete everything
            </button>
            <button class={s.btn} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <Note msg={msg} />
    </section>
  );
}

type Tri = 'global' | 'on' | 'off';
const toTri = (v: boolean | undefined): Tri => (v === undefined ? 'global' : v ? 'on' : 'off');
const fromTri = (t: Tri): boolean | null => (t === 'global' ? null : t === 'on');

function AccountsCard({
  accounts,
  error,
  onChange,
}: {
  accounts: AccountInfo[] | null;
  error: string | null;
  onChange: () => Promise<void>;
}) {
  const bus = useBus();
  const [msg, setMsg] = useState<Msg>(null);
  const patch = async (
    account: string,
    settings: { trackingDefault?: boolean | null; notificationsEnabled?: boolean | null },
  ) => {
    const r = await bus.send('UPDATE_ACCOUNT_SETTINGS', { account, settings });
    setMsg(
      r.ok ? { kind: 'ok', text: `Saved for ${account}.` } : { kind: 'err', text: r.error.message },
    );
    await onChange();
  };
  return (
    <section class={s.card} aria-labelledby="acct-h">
      <h2 id="acct-h">Gmail accounts</h2>
      <p>
        Every account (and “Send as” alias) Postmark has seen. Per-account settings override the
        defaults below.
      </p>
      {accounts === null ? (
        <p class={s.muted}>Loading…</p>
      ) : error && accounts.length === 0 ? (
        <p class={s.err} role="alert">
          Couldn’t load accounts: {error}
        </p>
      ) : accounts.length === 0 ? (
        <p class={s.muted}>
          No accounts yet. Open Gmail with the extension installed and they will appear here.
        </p>
      ) : (
        <table class={s.table}>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Tracked</th>
              <th scope="col">Track by default</th>
              <th scope="col">Notifications</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.account}>
                <td>{a.account}</td>
                <td class={s.muted}>{a.messageCount}</td>
                <td>
                  <select
                    class={s.select}
                    aria-label={`Track by default for ${a.account}`}
                    value={toTri(a.settings.trackingDefault)}
                    onChange={(e) =>
                      patch(a.account, {
                        trackingDefault: fromTri((e.target as HTMLSelectElement).value as Tri),
                      })
                    }
                  >
                    <option value="global">Use default</option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </td>
                <td>
                  <select
                    class={s.select}
                    aria-label={`Notifications for ${a.account}`}
                    value={toTri(a.settings.notificationsEnabled)}
                    onChange={(e) =>
                      patch(a.account, {
                        notificationsEnabled: fromTri((e.target as HTMLSelectElement).value as Tri),
                      })
                    }
                  >
                    <option value="global">Use default</option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Note msg={msg} />
    </section>
  );
}

function PrivacyCard() {
  return (
    <section class={`${s.card} ${s.prose}`} aria-labelledby="priv-h">
      <h2 id="priv-h">Privacy</h2>
      <p>
        <strong>What leaves your browser:</strong> for each tracked email, only its subject,
        recipient addresses, the URLs of links being tracked, and the sending account.{' '}
        <strong>Never the email body.</strong> The extension talks only to the Postmark server you
        configure above: no analytics, ads or third parties.
      </p>
      <p>
        <strong>What the server records about recipients:</strong> a salted hash of the requesting
        IP and a coarse client category (Gmail image proxy, Apple privacy proxy, security scanner,
        …). No raw IPs or user agents.
      </p>
      <p>
        <strong>Accuracy:</strong> open tracking is probabilistic. Image blocking hides real opens;
        privacy proxies and security scanners can create opens and clicks that no person made.
        Postmark labels these where it can, but never treat a status as proof.
      </p>
      <p>
        <strong>Your obligations:</strong> consent and disclosure rules for email tracking vary by
        jurisdiction (e.g. ePrivacy/GDPR in the EU/UK). You are responsible for compliance. The
        optional disclosure line can help.
      </p>
    </section>
  );
}
