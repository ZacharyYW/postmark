import type {
  AccountInfo,
  AccountSettings,
  EventType,
  MessageStatus,
  MessageSummary,
  Reminder,
  ReminderCondition,
  ReminderStatus,
  TrackingEvent,
  UaClass,
} from '@postmark/shared';
import { COUNTED_CLICK_CLASSES, COUNTED_OPEN_CLASSES } from '@postmark/shared';
import type { DB } from './db';

// ---------- row types ----------

export interface UserRow {
  id: string;
  email: string;
  token_hash: string;
  created_at: number;
  settings_json: string;
}

export interface MessageRow {
  id: string;
  user_id: string;
  sender_account: string;
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  subject: string;
  recipients_json: string;
  sent_at: number;
  tracking_enabled: number;
  pixel_id: string;
  client_request_id: string | null;
  replied_at: number | null;
  created_at: number;
}

export interface LinkRow {
  id: string;
  message_id: string;
  original_url: string;
  position: number;
}

export interface EventRow {
  id: number;
  message_id: string;
  link_id: string | null;
  type: EventType;
  occurred_at: number;
  ip_hash: string;
  ua_class: UaClass;
  is_first: number;
}

interface ReminderRow {
  id: string;
  message_id: string;
  remind_at: number;
  condition: ReminderCondition;
  status: ReminderStatus;
  created_at: number;
}

export interface UserSettingsJson {
  accounts?: Record<string, AccountSettings>;
}

const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');
const OPEN_IN = inList(COUNTED_OPEN_CLASSES);
const CLICK_IN = inList(COUNTED_CLICK_CLASSES);

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** All SQL lives here. Every user-scoped read takes `userId` so cross-user leaks are impossible by construction. */
export class Repo {
  constructor(private readonly db: DB) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------- users ----------

  createUser(u: Omit<UserRow, 'settings_json'>): void {
    this.db
      .prepare('INSERT INTO users(id, email, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(u.id, u.email, u.token_hash, u.created_at);
  }

  findUserByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  }

  findUserByTokenHash(hash: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE token_hash = ?').get(hash) as
      | UserRow
      | undefined;
  }

  updateUserToken(userId: string, tokenHash: string): void {
    this.db.prepare('UPDATE users SET token_hash = ? WHERE id = ?').run(tokenHash, userId);
  }

  deleteUser(userId: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  getUserSettings(userId: string): UserSettingsJson {
    const row = this.db.prepare('SELECT settings_json FROM users WHERE id = ?').get(userId) as
      | { settings_json: string }
      | undefined;
    return row ? parseJson<UserSettingsJson>(row.settings_json, {}) : {};
  }

  setUserSettings(userId: string, settings: UserSettingsJson): void {
    this.db
      .prepare('UPDATE users SET settings_json = ? WHERE id = ?')
      .run(JSON.stringify(settings), userId);
  }

  // ---------- messages & links ----------

  insertMessage(m: MessageRow): void {
    this.db
      .prepare(
        `INSERT INTO messages(id, user_id, sender_account, gmail_thread_id, gmail_message_id, subject,
           recipients_json, sent_at, tracking_enabled, pixel_id, client_request_id, replied_at, created_at)
         VALUES (@id, @user_id, @sender_account, @gmail_thread_id, @gmail_message_id, @subject,
           @recipients_json, @sent_at, @tracking_enabled, @pixel_id, @client_request_id, @replied_at, @created_at)`,
      )
      .run(m);
  }

  insertLink(l: LinkRow): void {
    this.db
      .prepare('INSERT INTO links(id, message_id, original_url, position) VALUES (?, ?, ?, ?)')
      .run(l.id, l.message_id, l.original_url, l.position);
  }

  linksForMessage(messageId: string): LinkRow[] {
    return this.db
      .prepare('SELECT * FROM links WHERE message_id = ? ORDER BY position')
      .all(messageId) as LinkRow[];
  }

  findMessageByClientRequest(userId: string, clientRequestId: string): MessageRow | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE user_id = ? AND client_request_id = ?')
      .get(userId, clientRequestId) as MessageRow | undefined;
  }

  getMessage(userId: string, id: string): MessageRow | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?')
      .get(id, userId) as MessageRow | undefined;
  }

  getMessageByPixel(pixelId: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE pixel_id = ?').get(pixelId) as
      | MessageRow
      | undefined;
  }

  getLinkWithMessage(linkId: string): { link: LinkRow; message: MessageRow } | undefined {
    const link = this.db.prepare('SELECT * FROM links WHERE id = ?').get(linkId) as
      | LinkRow
      | undefined;
    if (!link) return undefined;
    const message = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(link.message_id) as
      | MessageRow
      | undefined;
    return message ? { link, message } : undefined;
  }

  bindMessage(
    userId: string,
    id: string,
    patch: { gmailThreadId?: string; gmailMessageId?: string; repliedAt?: number },
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE messages SET
           gmail_thread_id = COALESCE(@t, gmail_thread_id),
           gmail_message_id = COALESCE(@m, gmail_message_id),
           replied_at = COALESCE(replied_at, @r)
         WHERE id = @id AND user_id = @u`,
      )
      .run({
        t: patch.gmailThreadId ?? null,
        m: patch.gmailMessageId ?? null,
        r: patch.repliedAt ?? null,
        id,
        u: userId,
      });
    return r.changes > 0;
  }

  listMessageRows(
    userId: string,
    f: {
      account?: string;
      accounts?: string[];
      since?: number;
      threadIds?: string[];
      q?: string;
      limit: number;
    },
  ): MessageRow[] {
    const where = ['user_id = @u'];
    const params: Record<string, unknown> = { u: userId, limit: f.limit };
    if (f.account) {
      where.push('sender_account = @account');
      params.account = f.account;
    }
    if (f.accounts && f.accounts.length > 0) {
      where.push('sender_account IN (SELECT value FROM json_each(@accounts))');
      params.accounts = JSON.stringify(f.accounts);
    }
    if (f.since !== undefined) {
      where.push('sent_at >= @since');
      params.since = f.since;
    }
    if (f.threadIds && f.threadIds.length > 0) {
      where.push('gmail_thread_id IN (SELECT value FROM json_each(@threadIds))');
      params.threadIds = JSON.stringify(f.threadIds);
    }
    if (f.q) {
      where.push(
        "(subject LIKE @q ESCAPE '\\' COLLATE NOCASE OR recipients_json LIKE @q ESCAPE '\\' COLLATE NOCASE)",
      );
      params.q = `%${escapeLike(f.q)}%`;
    }
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY sent_at DESC, id DESC LIMIT @limit`,
      )
      .all(params) as MessageRow[];
  }

  /** Aggregate open/click stats for message rows and build API summaries. */
  summarize(rows: MessageRow[]): MessageSummary[] {
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map((r) => r.id));
    type Agg = {
      message_id: string;
      opens: number;
      unique_opens: number;
      auto_loaded: number;
      first_open: number | null;
      last_open: number | null;
      clicks: number;
      last_click: number | null;
    };
    const aggs = this.db
      .prepare(
        `SELECT message_id,
           SUM(CASE WHEN type='open' AND ua_class IN (${OPEN_IN}) THEN 1 ELSE 0 END) AS opens,
           COUNT(DISTINCT CASE WHEN type='open' AND ua_class IN (${OPEN_IN}) THEN ip_hash END) AS unique_opens,
           SUM(CASE WHEN type='open' AND ua_class='apple_mpp' THEN 1 ELSE 0 END) AS auto_loaded,
           MIN(CASE WHEN type='open' AND ua_class IN (${OPEN_IN}) THEN occurred_at END) AS first_open,
           MAX(CASE WHEN type='open' AND ua_class IN (${OPEN_IN}) THEN occurred_at END) AS last_open,
           SUM(CASE WHEN type='click' AND ua_class IN (${CLICK_IN}) THEN 1 ELSE 0 END) AS clicks,
           MAX(CASE WHEN type='click' AND ua_class IN (${CLICK_IN}) THEN occurred_at END) AS last_click
         FROM events WHERE message_id IN (SELECT value FROM json_each(?))
         GROUP BY message_id`,
      )
      .all(ids) as Agg[];
    const aggBy = new Map(aggs.map((a) => [a.message_id, a]));

    type Last = { message_id: string; type: EventType; occurred_at: number; ua_class: UaClass };
    const lasts = this.db
      .prepare(
        `SELECT message_id, type, occurred_at, ua_class FROM (
           SELECT message_id, type, occurred_at, ua_class,
             ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY occurred_at DESC, id DESC) AS rn
           FROM events
           WHERE message_id IN (SELECT value FROM json_each(?)) AND ua_class NOT IN ('bot','sender')
         ) WHERE rn = 1`,
      )
      .all(ids) as Last[];
    const lastBy = new Map(lasts.map((l) => [l.message_id, l]));

    type LinkAgg = LinkRow & { clicks: number; last_click: number | null };
    const links = this.db
      .prepare(
        `SELECT l.id, l.message_id, l.original_url, l.position,
           COUNT(e.id) AS clicks, MAX(e.occurred_at) AS last_click
         FROM links l
         LEFT JOIN events e ON e.link_id = l.id AND e.type = 'click' AND e.ua_class IN (${CLICK_IN})
         WHERE l.message_id IN (SELECT value FROM json_each(?))
         GROUP BY l.id ORDER BY l.position`,
      )
      .all(ids) as LinkAgg[];
    const linksBy = new Map<string, LinkAgg[]>();
    for (const l of links) {
      const arr = linksBy.get(l.message_id) ?? [];
      arr.push(l);
      linksBy.set(l.message_id, arr);
    }

    return rows.map((r) => {
      const a = aggBy.get(r.id);
      const last = lastBy.get(r.id);
      const opens = a?.opens ?? 0;
      const clicks = a?.clicks ?? 0;
      const autoLoaded = a?.auto_loaded ?? 0;
      const status: MessageStatus =
        clicks > 0 ? 'clicked' : opens > 0 ? 'opened' : autoLoaded > 0 ? 'auto_loaded' : 'sent';
      return {
        id: r.id,
        senderAccount: r.sender_account,
        gmailThreadId: r.gmail_thread_id,
        gmailMessageId: r.gmail_message_id,
        subject: r.subject,
        recipients: parseJson<string[]>(r.recipients_json, []),
        sentAt: new Date(r.sent_at).toISOString(),
        trackingEnabled: r.tracking_enabled === 1,
        repliedAt: iso(r.replied_at),
        opens: {
          total: opens,
          unique: a?.unique_opens ?? 0,
          autoLoaded,
          first: iso(a?.first_open),
          last: iso(a?.last_open),
        },
        clicks: { total: clicks, last: iso(a?.last_click) },
        links: (linksBy.get(r.id) ?? []).map((l) => ({
          id: l.id,
          originalUrl: l.original_url,
          position: l.position,
          clicks: l.clicks,
          lastClick: iso(l.last_click),
        })),
        lastEvent: last
          ? { type: last.type, occurredAt: iso(last.occurred_at) ?? '', uaClass: last.ua_class }
          : null,
        status,
      };
    });
  }

  // ---------- events ----------

  insertEvent(e: Omit<EventRow, 'id'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO events(message_id, link_id, type, occurred_at, ip_hash, ua_class, is_first)
         VALUES (@message_id, @link_id, @type, @occurred_at, @ip_hash, @ua_class, @is_first)`,
      )
      .run(e);
    return Number(r.lastInsertRowid);
  }

  hasRecentDuplicate(e: {
    message_id: string;
    link_id: string | null;
    type: EventType;
    ip_hash: string;
    ua_class: UaClass;
    after: number;
  }): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM events WHERE message_id = @message_id AND type = @type
           AND link_id IS @link_id AND ip_hash = @ip_hash AND ua_class = @ua_class
           AND occurred_at >= @after LIMIT 1`,
      )
      .get(e);
    return row !== undefined;
  }

  /** Set is_first=1 on the earliest counted event (per message for opens, per link for clicks). */
  recomputeFirst(messageId: string, type: EventType, linkId: string | null): void {
    const counted = type === 'open' ? OPEN_IN : CLICK_IN;
    const linkClause = type === 'click' ? 'AND link_id IS @link' : '';
    const params = { m: messageId, t: type, link: linkId };
    this.db
      .prepare(`UPDATE events SET is_first = 0 WHERE message_id = @m AND type = @t ${linkClause}`)
      .run(params);
    this.db
      .prepare(
        `UPDATE events SET is_first = 1 WHERE id = (
           SELECT id FROM events WHERE message_id = @m AND type = @t ${linkClause}
             AND ua_class IN (${counted})
           ORDER BY occurred_at ASC, id ASC LIMIT 1)`,
      )
      .run(params);
  }

  insertSelfView(messageId: string, account: string, at: number): void {
    this.db
      .prepare('INSERT INTO self_views(message_id, account, viewed_at) VALUES (?, ?, ?)')
      .run(messageId, account, at);
  }

  hasSelfViewNear(messageId: string, account: string, at: number, windowMs: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM self_views WHERE message_id = ? AND account = ?
             AND viewed_at BETWEEN ? AND ? LIMIT 1`,
        )
        .get(messageId, account, at - windowMs, at + windowMs) !== undefined
    );
  }

  /** Reclassify Gmail-proxy opens near a self-view as sender opens. Returns rows changed. */
  reclassifyProxyOpensAsSender(messageId: string, at: number, windowMs: number): number {
    return this.db
      .prepare(
        `UPDATE events SET ua_class = 'sender', is_first = 0
         WHERE message_id = ? AND type = 'open' AND ua_class = 'gmail_proxy'
           AND occurred_at BETWEEN ? AND ?`,
      )
      .run(messageId, at - windowMs, at + windowMs).changes;
  }

  eventsForMessage(userId: string, messageId: string): TrackingEvent[] {
    return this.eventQuery('m.user_id = @u AND e.message_id = @mid ORDER BY e.id ASC', {
      u: userId,
      mid: messageId,
    });
  }

  /** Events for polling: id > cursor, optionally filtered by account, ordered by id. */
  eventsAfter(
    userId: string,
    f: { cursor?: number; since?: number; account?: string; limit: number },
  ): TrackingEvent[] {
    const where = ['m.user_id = @u'];
    const params: Record<string, unknown> = { u: userId, limit: f.limit };
    if (f.cursor !== undefined) {
      where.push('e.id > @cursor');
      params.cursor = f.cursor;
    }
    if (f.since !== undefined) {
      where.push('e.occurred_at >= @since');
      params.since = f.since;
    }
    if (f.account) {
      where.push('m.sender_account = @account');
      params.account = f.account;
    }
    return this.eventQuery(`${where.join(' AND ')} ORDER BY e.id ASC LIMIT @limit`, params);
  }

  maxEventIdForUser(userId: string): number {
    const row = this.db
      .prepare(
        'SELECT MAX(e.id) AS id FROM events e JOIN messages m ON m.id = e.message_id WHERE m.user_id = ?',
      )
      .get(userId) as { id: number | null };
    return row.id ?? 0;
  }

  private eventQuery(whereAndOrder: string, params: Record<string, unknown>): TrackingEvent[] {
    type Row = EventRow & {
      sender_account: string;
      subject: string;
      recipients_json: string;
      gmail_thread_id: string | null;
      original_url: string | null;
    };
    const rows = this.db
      .prepare(
        `SELECT e.*, m.sender_account, m.subject, m.recipients_json, m.gmail_thread_id, l.original_url
         FROM events e
         JOIN messages m ON m.id = e.message_id
         LEFT JOIN links l ON l.id = e.link_id
         WHERE ${whereAndOrder}`,
      )
      .all(params) as Row[];
    return rows.map((r) => ({
      id: r.id,
      messageId: r.message_id,
      linkId: r.link_id,
      linkUrl: r.original_url,
      type: r.type,
      occurredAt: new Date(r.occurred_at).toISOString(),
      uaClass: r.ua_class,
      isFirst: r.is_first === 1,
      senderAccount: r.sender_account,
      subject: r.subject,
      recipients: parseJson<string[]>(r.recipients_json, []),
      gmailThreadId: r.gmail_thread_id,
    }));
  }

  // ---------- accounts ----------

  accounts(userId: string): AccountInfo[] {
    const rows = this.db
      .prepare(
        `SELECT sender_account AS account, COUNT(*) AS c, MAX(sent_at) AS last
         FROM messages WHERE user_id = ? GROUP BY sender_account`,
      )
      .all(userId) as { account: string; c: number; last: number }[];
    const settings = this.getUserSettings(userId).accounts ?? {};
    const byAccount = new Map<string, AccountInfo>();
    for (const r of rows) {
      byAccount.set(r.account, {
        account: r.account,
        messageCount: r.c,
        lastSentAt: iso(r.last),
        settings: settings[r.account] ?? {},
      });
    }
    for (const [account, s] of Object.entries(settings)) {
      if (!byAccount.has(account)) {
        byAccount.set(account, { account, messageCount: 0, lastSentAt: null, settings: s });
      }
    }
    return [...byAccount.values()].sort((a, b) => a.account.localeCompare(b.account));
  }

  // ---------- reminders ----------

  insertReminder(r: ReminderRow): void {
    this.db
      .prepare(
        `INSERT INTO reminders(id, message_id, remind_at, condition, status, created_at)
         VALUES (@id, @message_id, @remind_at, @condition, @status, @created_at)`,
      )
      .run(r);
  }

  listReminders(
    userId: string,
    f: { status?: ReminderStatus; account?: string; id?: string },
  ): Reminder[] {
    const where = ['m.user_id = @u'];
    const params: Record<string, unknown> = { u: userId };
    if (f.status) {
      where.push('r.status = @status');
      params.status = f.status;
    }
    if (f.account) {
      where.push('m.sender_account = @account');
      params.account = f.account;
    }
    if (f.id) {
      where.push('r.id = @id');
      params.id = f.id;
    }
    type Row = ReminderRow & {
      subject: string;
      recipients_json: string;
      sender_account: string;
      gmail_thread_id: string | null;
    };
    const rows = this.db
      .prepare(
        `SELECT r.*, m.subject, m.recipients_json, m.sender_account, m.gmail_thread_id
         FROM reminders r JOIN messages m ON m.id = r.message_id
         WHERE ${where.join(' AND ')} ORDER BY r.remind_at ASC`,
      )
      .all(params) as Row[];
    return rows.map((r) => ({
      id: r.id,
      messageId: r.message_id,
      remindAt: new Date(r.remind_at).toISOString(),
      condition: r.condition,
      status: r.status,
      createdAt: new Date(r.created_at).toISOString(),
      subject: r.subject,
      recipients: parseJson<string[]>(r.recipients_json, []),
      senderAccount: r.sender_account,
      gmailThreadId: r.gmail_thread_id,
    }));
  }

  updateReminderStatus(userId: string, id: string, status: ReminderStatus): boolean {
    return (
      this.db
        .prepare(
          `UPDATE reminders SET status = ? WHERE id = ? AND message_id IN
             (SELECT id FROM messages WHERE user_id = ?)`,
        )
        .run(status, id, userId).changes > 0
    );
  }

  deleteReminder(userId: string, id: string): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM reminders WHERE id = ? AND message_id IN
             (SELECT id FROM messages WHERE user_id = ?)`,
        )
        .run(id, userId).changes > 0
    );
  }
}
