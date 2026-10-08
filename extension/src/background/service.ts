import {
  normalizeAccount,
  resolveSettings,
  BUILTIN_DEFAULTS,
  GlobalSettingsSchema,
  TIMING,
  gmailThreadUrl,
  isInQuietHours,
  type AccountInfo,
  type AccountSettings,
  type GlobalSettings,
  type MessageSummary,
  type PushEnvelope,
  type TrackingEvent,
} from '@postmark/shared';
import { HandlerError, type HandlerContext, type Handlers } from '../bus/router';
import { DEFAULT_SERVER_URL } from '../config';
import { ApiClient } from './api';
import { planNotifications, summarizeQueue, type NotificationSpec } from './notify';
import {
  POLL_ALARM,
  REMINDER_ALARM_PREFIX,
  reminderStillUnmet,
  reminderText,
} from './reminderLogic';
import {
  getLocal,
  getSession,
  removeLocal,
  serialized,
  setLocal,
  setSession,
  type TabScope,
} from './storage';

const log = (...args: unknown[]) => console.warn('[postmark]', ...args);

export function normalizeServerUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HandlerError('VALIDATION', 'Server URL must be a valid http(s) URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new HandlerError('VALIDATION', 'Server URL must start with http:// or https://');
  }
  const isLocal = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol === 'http:' && !isLocal) {
    throw new HandlerError('VALIDATION', 'Use https:// for non-local servers');
  }
  return u.origin;
}

export class PostmarkService {
  readonly api: ApiClient;

  constructor(fetchImpl?: typeof fetch) {
    this.api = new ApiClient(async () => {
      const [serverUrl, auth] = await Promise.all([getLocal('serverUrl'), getLocal('auth')]);
      return { baseUrl: serverUrl ?? DEFAULT_SERVER_URL, token: auth?.token ?? null };
    }, fetchImpl);
  }

  // ---------- tab ↔ account scope ----------

  async tabScope(tabId: number | undefined): Promise<TabScope | null> {
    if (tabId === undefined) return null;
    const map = (await getSession('tabAccounts')) ?? {};
    return map[String(tabId)] ?? null;
  }

  private async requireScope(ctx: HandlerContext): Promise<TabScope> {
    const scope = await this.tabScope(ctx.tabId);
    if (!scope) throw new HandlerError('NO_ACCOUNT', 'This tab has not reported its Gmail account');
    return scope;
  }

  static scopeAccounts(scope: TabScope): string[] {
    return [...new Set([scope.account, ...scope.aliases])];
  }

  async setTabAccount(tabId: number, account: string, aliases: string[]): Promise<void> {
    const acct = normalizeAccount(account);
    if (!acct) throw new HandlerError('VALIDATION', 'Invalid account');
    const cleanAliases = aliases
      .map(normalizeAccount)
      .filter((a): a is string => a !== null && a !== acct);
    await serialized(async () => {
      const stored = (await getLocal('accountAliases')) ?? {};
      const mergedAliases = [...new Set([...(stored[acct] ?? []), ...cleanAliases])];
      const map = (await getSession('tabAccounts')) ?? {};
      map[String(tabId)] = { account: acct, aliases: mergedAliases };
      const known = new Set((await getLocal('knownAccounts')) ?? []);
      known.add(acct);
      mergedAliases.forEach((a) => known.add(a));
      await setSession({ tabAccounts: map });
      await setLocal({
        accountAliases: { ...stored, [acct]: mergedAliases },
        knownAccounts: [...known].sort(),
      });
    });
    await this.schedulePolling();
  }

  async forgetTab(tabId: number): Promise<void> {
    await serialized(async () => {
      const map = (await getSession('tabAccounts')) ?? {};
      if (!(String(tabId) in map)) return;
      delete map[String(tabId)];
      await setSession({ tabAccounts: map });
    });
    await this.schedulePolling();
  }

  async rememberAccount(account: string): Promise<void> {
    await serialized(async () => {
      const known = new Set((await getLocal('knownAccounts')) ?? []);
      if (known.has(account)) return;
      known.add(account);
      await setLocal({ knownAccounts: [...known].sort() });
    });
  }

  // ---------- settings ----------

  async globalSettings(): Promise<GlobalSettings> {
    const stored = (await getLocal('globalSettings')) ?? {};
    return { ...BUILTIN_DEFAULTS, ...stored };
  }

  async accountSettings(account: string): Promise<AccountSettings | null> {
    const cache = (await getLocal('accountsCache')) ?? [];
    return cache.find((a) => a.account === account)?.settings ?? null;
  }

  async refreshAccounts(): Promise<AccountInfo[]> {
    const { accounts } = await this.api.accounts();
    await setLocal({ accountsCache: accounts });
    return accounts;
  }

  async resolver(): Promise<(account: string) => ReturnType<typeof resolveSettings>> {
    const [global, cache] = await Promise.all([this.globalSettings(), getLocal('accountsCache')]);
    const by = new Map((cache ?? []).map((a) => [a.account, a.settings]));
    return (account: string) => resolveSettings(by.get(account) ?? null, global);
  }

  // ---------- polling & notifications ----------

  async schedulePolling(): Promise<void> {
    const loggedIn = Boolean(await getLocal('auth'));
    if (!loggedIn) {
      await chrome.alarms.clear(POLL_ALARM);
      return;
    }
    const tabs = (await getSession('tabAccounts')) ?? {};
    const period = Object.keys(tabs).length > 0 ? 1 : 5;
    const existing = await chrome.alarms.get(POLL_ALARM);
    if (existing?.periodInMinutes === period) return;
    await chrome.alarms.create(POLL_ALARM, { periodInMinutes: period, delayInMinutes: 0.5 });
  }

  async poll(): Promise<void> {
    if (!(await getLocal('auth'))) return;
    try {
      let cursor = (await getLocal('pollCursor')) ?? null;
      const all: TrackingEvent[] = [];
      for (let page = 0; page < 5; page++) {
        const res = await this.api.events(cursor);
        all.push(...res.events);
        const advanced = res.cursor !== cursor;
        cursor = res.cursor;
        if (res.events.length === 0 || !advanced) break;
      }
      if (cursor !== null) await setLocal({ pollCursor: cursor });
      // Refresh per-account settings occasionally (cheap) so precedence stays current.
      await this.refreshAccounts().catch(() => undefined);
      await this.flushQuietQueue();
      if (all.length > 0) {
        await this.notify(all);
        await this.broadcastUpdate(all);
      }
      await setLocal({ lastPoll: { at: Date.now(), ok: true } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setLocal({ lastPoll: { at: Date.now(), ok: false, error: message } });
      if (err instanceof HandlerError && err.code === 'NOT_AUTHENTICATED') {
        log('token rejected; signing out');
        await this.logout();
      }
    }
  }

  private async notify(events: TrackingEvent[]): Promise<void> {
    const resolve = await this.resolver();
    const known = (await getLocal('knownAccounts')) ?? [];
    const accounts = new Set([...known, ...events.map((e) => e.senderAccount)]);
    const plan = planNotifications(events, {
      resolve,
      multiAccount: accounts.size > 1,
      now: new Date(),
    });
    for (const spec of plan.show) await this.showNotification(spec);
    if (plan.queued.length > 0) {
      await serialized(async () => {
        const queue = (await getLocal('quietQueue')) ?? [];
        queue.push(
          ...plan.queued.map((q) => ({
            kind: q.kind === 'click' ? ('click' as const) : ('open' as const),
            messageId: q.messageId ?? '',
            subject: q.title,
            account: q.account ?? '',
          })),
        );
        await setLocal({ quietQueue: queue.slice(-200) });
      });
    }
  }

  /** Release held notifications whose account is no longer in (its own) quiet hours. */
  private async flushQuietQueue(): Promise<void> {
    const resolve = await this.resolver();
    const now = new Date();
    const ready = await serialized(async () => {
      const queue = (await getLocal('quietQueue')) ?? [];
      if (queue.length === 0) return [];
      const release = queue.filter((q) => !isInQuietHours(resolve(q.account).quietHours, now));
      if (release.length === 0) return [];
      await setLocal({ quietQueue: queue.filter((q) => !release.includes(q)) });
      return release;
    });
    const summary = summarizeQueue(ready, now);
    if (summary) await this.showNotification(summary);
  }

  async showNotification(spec: NotificationSpec): Promise<void> {
    if (spec.account) {
      await serialized(async () => {
        const targets = (await getLocal('notifTargets')) ?? {};
        targets[spec.id] = { threadId: spec.threadId, account: spec.account ?? '' };
        const entries = Object.entries(targets).slice(-100);
        await setLocal({ notifTargets: Object.fromEntries(entries) });
      });
    }
    await chrome.notifications.create(spec.id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: spec.title,
      message: spec.message,
      ...(spec.contextMessage !== undefined && { contextMessage: spec.contextMessage }),
      priority: 0,
    });
  }

  async onNotificationClicked(id: string): Promise<void> {
    const targets = (await getLocal('notifTargets')) ?? {};
    const t = targets[id];
    await chrome.notifications.clear(id);
    if (t?.threadId) {
      await chrome.tabs.create({ url: gmailThreadUrl(t.threadId, t.account || null) });
    } else if (t?.account) {
      await chrome.tabs.create({
        url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(t.account)}#sent`,
      });
    } else {
      await chrome.runtime.openOptionsPage().catch(() => undefined);
    }
  }

  /** Tell Gmail tabs whose account (or alias) sent the affected messages to refresh marks. */
  async broadcastUpdate(
    events: { messageId: string; senderAccount: string; gmailThreadId: string | null }[],
  ): Promise<void> {
    const tabs = (await getSession('tabAccounts')) ?? {};
    for (const [tabId, scope] of Object.entries(tabs)) {
      const accounts = new Set(PostmarkService.scopeAccounts(scope));
      const relevant = events.filter((e) => accounts.has(e.senderAccount));
      if (relevant.length === 0) continue;
      const push: PushEnvelope<'DATA_UPDATED'> = {
        __postmarkPush: 1,
        type: 'DATA_UPDATED',
        payload: {
          messageIds: [...new Set(relevant.map((e) => e.messageId))],
          threadIds: [
            ...new Set(relevant.map((e) => e.gmailThreadId).filter((t): t is string => t !== null)),
          ],
        },
      };
      await chrome.tabs.sendMessage(Number(tabId), push).catch(() => undefined);
    }
  }

  // ---------- reminders ----------

  async syncReminderAlarms(): Promise<void> {
    if (!(await getLocal('auth'))) return;
    const { reminders } = await this.api.listReminders({ status: 'pending' });
    const existing = new Set(
      (await chrome.alarms.getAll())
        .map((a) => a.name)
        .filter((n) => n.startsWith(REMINDER_ALARM_PREFIX)),
    );
    for (const r of reminders) {
      const name = `${REMINDER_ALARM_PREFIX}${r.id}`;
      if (existing.has(name)) continue;
      await chrome.alarms.create(name, {
        when: Math.max(Date.now() + 1000, Date.parse(r.remindAt)),
      });
    }
  }

  async onReminderAlarm(reminderId: string): Promise<void> {
    const { reminders } = await this.api.listReminders({ status: 'pending' });
    const r = reminders.find((x) => x.id === reminderId);
    if (!r) return; // deleted, already handled, or other user
    const message = await this.api.getMessage(r.messageId);
    if (!reminderStillUnmet(r.condition, message)) {
      await this.api.patchReminder(r.id, 'satisfied');
      return;
    }
    const resolve = await this.resolver();
    const settings = resolve(message.senderAccount);
    await this.api.patchReminder(r.id, 'fired');
    if (!settings.notifyReminders) return;
    const known = (await getLocal('knownAccounts')) ?? [];
    const via = known.length > 1 ? ` · via ${message.senderAccount}` : '';
    await this.showNotification({
      id: `pm:reminder:${r.id}`,
      kind: 'reminder',
      title: `Follow up: ${message.subject || '(no subject)'}`,
      message: `${reminderText(r.condition, message)}${via}`,
      messageId: message.id,
      threadId: message.gmailThreadId,
      account: message.senderAccount,
    });
  }

  // ---------- auth ----------

  async logout(): Promise<void> {
    await removeLocal([
      'auth',
      'pollCursor',
      'accountsCache',
      'quietQueue',
      'notifTargets',
      'lastPoll',
    ]);
    const alarms = await chrome.alarms.getAll();
    await Promise.all(
      alarms
        .filter((a) => a.name === POLL_ALARM || a.name.startsWith(REMINDER_ALARM_PREFIX))
        .map((a) => chrome.alarms.clear(a.name)),
    );
  }

  private async afterLogin(token: string, email: string): Promise<void> {
    await setLocal({ auth: { token, email } });
    await removeLocal(['pollCursor']);
    // Bootstrap the cursor so a new login doesn't replay historical events as notifications.
    const res = await this.api.events(null).catch(() => null);
    if (res) await setLocal({ pollCursor: res.cursor });
    await this.refreshAccounts().catch(() => undefined);
    await this.schedulePolling();
    await this.syncReminderAlarms().catch(() => undefined);
  }

  private async applyServerUrl(serverUrl: string | undefined): Promise<void> {
    if (serverUrl === undefined) return;
    await setLocal({ serverUrl: normalizeServerUrl(serverUrl) });
  }

  // ---------- handlers ----------

  handlers(): Handlers {
    return {
      ACTIVE_ACCOUNT: async ({ account, aliases }, ctx) => {
        if (ctx.tabId === undefined)
          throw new HandlerError('VALIDATION', 'Only Gmail tabs report accounts');
        await this.setTabAccount(ctx.tabId, account, aliases ?? []);
        return { ok: true };
      },

      PREPARE_TRACKING: async (p, ctx) => {
        const sender = normalizeAccount(p.senderAccount);
        if (!sender)
          throw new HandlerError('NO_ACCOUNT', 'Could not determine the sending account');
        const scope = await this.tabScope(ctx.tabId);
        if (
          scope &&
          sender !== scope.account &&
          !scope.aliases.includes(sender) &&
          ctx.tabId !== undefined
        ) {
          // A "Send as" alias we hadn't seen yet: remember it for this tab's scope.
          await this.setTabAccount(ctx.tabId, scope.account, [...scope.aliases, sender]);
        }
        await this.rememberAccount(sender);
        return this.api.createMessage(
          {
            senderAccount: sender,
            subject: p.subject,
            recipients: p.recipients,
            links: p.links,
            clientRequestId: p.clientRequestId,
          },
          TIMING.PRESEND_TIMEOUT_MS,
        );
      },

      BIND_SENT: async (p, ctx) => {
        const body: { gmailThreadId?: string; gmailMessageId?: string } = {};
        if (p.gmailThreadId) body.gmailThreadId = p.gmailThreadId;
        if (p.gmailMessageId) body.gmailMessageId = p.gmailMessageId;
        if (Object.keys(body).length === 0) return { ok: true };
        const summary = await this.api.bindMessage(p.messageId, body);
        if (ctx.tabId !== undefined) {
          await this.broadcastUpdate([
            {
              messageId: summary.id,
              senderAccount: summary.senderAccount,
              gmailThreadId: summary.gmailThreadId,
            },
          ]);
        }
        return { ok: true };
      },

      GET_MARKS: async ({ threadIds }, ctx) => {
        const scope = await this.requireScope(ctx);
        const ids = [...new Set(threadIds)].slice(0, 100);
        if (ids.length === 0) return { marks: {} };
        const { messages } = await this.api.listMessages({
          accounts: PostmarkService.scopeAccounts(scope),
          threadIds: ids,
          limit: 200,
        });
        const marks: Record<string, MessageSummary[]> = {};
        for (const m of messages) {
          if (!m.gmailThreadId) continue;
          (marks[m.gmailThreadId] ??= []).push(m);
        }
        return { marks };
      },

      GET_THREAD_TRACKING: async ({ threadId }, ctx) => {
        const scope = await this.requireScope(ctx);
        const { messages } = await this.api.listMessages({
          accounts: PostmarkService.scopeAccounts(scope),
          threadIds: [threadId],
          limit: 50,
        });
        return { messages };
      },

      SELF_VIEW: async ({ messageId }, ctx) => {
        const scope = await this.requireScope(ctx);
        const m = await this.api.getMessage(messageId);
        // Only the sending account's own view is a self-view; never send a beacon otherwise.
        if (!PostmarkService.scopeAccounts(scope).includes(m.senderAccount)) return { ok: true };
        await this.api.selfView(messageId, m.senderAccount);
        return { ok: true };
      },

      REPORT_REPLY: async ({ messageId }) => {
        await this.api.bindMessage(messageId, { repliedAt: new Date().toISOString() });
        return { ok: true };
      },

      GET_SETTINGS: async ({ account }) => {
        const global = await this.globalSettings();
        const acct = account ? normalizeAccount(account) : null;
        const accountSettings = acct ? await this.accountSettings(acct) : null;
        return {
          global,
          account: accountSettings,
          resolved: resolveSettings(accountSettings, global),
        };
      },

      UPDATE_GLOBAL_SETTINGS: async (patch) => {
        const current = await this.globalSettings();
        const next = GlobalSettingsSchema.safeParse({ ...current, ...patch });
        if (!next.success) throw new HandlerError('VALIDATION', 'Invalid settings');
        await setLocal({ globalSettings: next.data });
        return next.data;
      },

      UPDATE_ACCOUNT_SETTINGS: async ({ account, settings }) => {
        const acct = normalizeAccount(account);
        if (!acct) throw new HandlerError('VALIDATION', 'Invalid account');
        const info = await this.api.patchAccount(acct, settings);
        await this.refreshAccounts().catch(() => undefined);
        return info;
      },

      GET_AUTH_STATE: async () => {
        const [auth, serverUrl] = await Promise.all([getLocal('auth'), getLocal('serverUrl')]);
        return {
          loggedIn: Boolean(auth),
          email: auth?.email ?? null,
          serverUrl: serverUrl ?? DEFAULT_SERVER_URL,
        };
      },

      REGISTER: async ({ email, serverUrl }) => {
        await this.applyServerUrl(serverUrl);
        const res = await this.api.register(email);
        await this.afterLogin(res.token, res.email);
        return { email: res.email };
      },

      CONNECT_TOKEN: async ({ token, serverUrl }) => {
        await this.applyServerUrl(serverUrl);
        const trimmed = token.trim();
        if (!/^[A-Za-z0-9_-]{20,200}$/.test(trimmed))
          throw new HandlerError('VALIDATION', 'That doesn’t look like a Postmark token');
        await setLocal({ auth: { token: trimmed, email: '' } });
        try {
          const me = await this.api.me();
          await this.afterLogin(trimmed, me.email);
          return { email: me.email };
        } catch (err) {
          await removeLocal(['auth']);
          throw err;
        }
      },

      LOGOUT: async () => {
        await this.logout();
        return { ok: true };
      },

      DELETE_ME: async () => {
        await this.api.deleteMe();
        await this.logout();
        await removeLocal(['knownAccounts', 'accountAliases', 'popupAccount']);
        return { ok: true };
      },

      SET_SERVER_URL: async ({ serverUrl }) => {
        const url = normalizeServerUrl(serverUrl);
        const current = (await getLocal('serverUrl')) ?? DEFAULT_SERVER_URL;
        if (url !== current) {
          // A token is only valid for the server that issued it.
          await this.logout();
          await setLocal({ serverUrl: url });
        }
        return { serverUrl: url };
      },

      LIST_MESSAGES: async ({ account, limit, q }) => {
        const acct = account ? normalizeAccount(account) : null;
        return this.api.listMessages({
          account: acct,
          limit: limit ?? 50,
          ...(q && q.trim() && { q: q.trim() }),
        });
      },

      LIST_ACCOUNTS: async () => {
        const accounts = await this.refreshAccounts().catch(async (err: unknown) => {
          const cached = await getLocal('accountsCache');
          if (cached) return cached;
          throw err;
        });
        // Include accounts seen in Gmail tabs that haven't sent anything yet (spec 6.6 edge case).
        const known = (await getLocal('knownAccounts')) ?? [];
        const have = new Set(accounts.map((a) => a.account));
        const extra = known
          .filter((k) => !have.has(k))
          .map((account) => ({ account, messageCount: 0, lastSentAt: null, settings: {} }));
        return {
          accounts: [...accounts, ...extra].sort((a, b) => a.account.localeCompare(b.account)),
        };
      },

      LIST_REMINDERS: async ({ account }) => {
        const acct = account ? normalizeAccount(account) : null;
        return this.api.listReminders({ status: 'pending', account: acct });
      },

      CREATE_REMINDER: async (p) => {
        const r = await this.api.createReminder(p);
        await chrome.alarms.create(`${REMINDER_ALARM_PREFIX}${r.id}`, {
          when: Math.max(Date.now() + 1000, Date.parse(r.remindAt)),
        });
        return r;
      },

      DELETE_REMINDER: async ({ id }) => {
        await this.api.deleteReminder(id);
        await chrome.alarms.clear(`${REMINDER_ALARM_PREFIX}${id}`);
        return { ok: true };
      },

      GET_ACTIVE_TAB_ACCOUNT: async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id === undefined) return { account: null };
        return { account: (await this.tabScope(tab.id))?.account ?? null };
      },

      OPEN_THREAD: async ({ gmailThreadId, account }) => {
        await chrome.tabs.create({ url: gmailThreadUrl(gmailThreadId, account) });
        return { ok: true };
      },
    };
  }
}
