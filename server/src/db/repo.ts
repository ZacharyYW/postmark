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
import { stmt, type SqlDb, type SqlValue, type Stmt } from './sql';

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

/**
 * All SQL lives here. Every user-scoped read takes `userId` so cross-user leaks are impossible by
 * construction. Async so the same code runs on better-sqlite3 (Node) and Cloudflare D1. Multi-step
 * writes use `batch` (atomic on both); there are no interactive transactions (D1 has none).
 */
export class Repo {
  constructor(private readonly db: SqlDb) {}

  // ---------- users ----------

  async createUser(u: Omit<UserRow, 'settings_json'>): Promise<void> {
    await this.db.run(
      'INSERT INTO users(id, email, token_hash, created_at) VALUES (?, ?, ?, ?)',
      u.id,
      u.email,
      u.token_hash,
      u.created_at,
    );
  }

  findUserByEmail(email: string): Promise<UserRow | undefined> {
    return this.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
  }

  findUserByTokenHash(hash: string): Promise<UserRow | undefined> {
    return this.db.get<UserRow>('SELECT * FROM users WHERE token_hash = ?', hash);
  }

  async updateUserToken(userId: string, tokenHash: string): Promise<void> {
    await this.db.run('UPDATE users SET token_hash = ? WHERE id = ?', tokenHash, userId);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.db.run('DELETE FROM users WHERE id = ?', userId);
  }

  async getUserSettings(userId: string): Promise<UserSettingsJson> {
    const row = await this.db.get<{ settings_json: string }>(
      'SELECT settings_json FROM users WHERE id = ?',
      userId,
    );
    return row ? parseJson<UserSettingsJson>(row.settings_json, {}) : {};
  }

  async setUserSettings(userId: string, settings: UserSettingsJson): Promise<void> {
    await this.db.run(
      'UPDATE users SET settings_json = ? WHERE id = ?',
      JSON.stringify(settings),
      userId,
    );
  }

  // ---------- messages & links ----------

  private static insertMessageStmt(m: MessageRow): Stmt {
    return stmt(
      `INSERT INTO messages(id, user_id, sender_account, gmail_thread_id, gmail_message_id, subject,
         recipients_json, sent_at, tracking_enabled, pixel_id, client_request_id, replied_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.id,
      m.user_id,
      m.sender_account,
      m.gmail_thread_id,
      m.gmail_message_id,
      m.subject,
      m.recipients_json,
      m.sent_at,
      m.tracking_enabled,
      m.pixel_id,
      m.client_request_id,
      m.replied_at,
      m.created_at,
    );
  }

  private static insertLinkStmt(l: LinkRow): Stmt {
    return stmt(
      'INSERT INTO links(id, message_id, original_url, position) VALUES (?, ?, ?, ?)',
      l.id,
      l.message_id,
      l.original_url,
      l.position,
    );
  }

  /** Insert a message and its links atomically. */
  async insertMessageWithLinks(m: MessageRow, links: LinkRow[]): Promise<void> {
    await this.db.batch([Repo.insertMessageStmt(m), ...links.map(Repo.insertLinkStmt)]);
  }

  async insertLinks(links: LinkRow[]): Promise<void> {
    await this.db.batch(links.map(Repo.insertLinkStmt));
  }

  linksForMessage(messageId: string): Promise<LinkRow[]> {
    return this.db.all<LinkRow>(
      'SELECT * FROM links WHERE message_id = ? ORDER BY position',
      messageId,
    );
  }

  findMessageByClientRequest(
    userId: string,
    clientRequestId: string,
  ): Promise<MessageRow | undefined> {
    return this.db.get<MessageRow>(
      'SELECT * FROM messages WHERE user_id = ? AND client_request_id = ?',
      userId,
      clientRequestId,
    );
  }

  getMessage(userId: string, id: string): Promise<MessageRow | undefined> {
    return this.db.get<MessageRow>(
      'SELECT * FROM messages WHERE id = ? AND user_id = ?',
      id,
      userId,
    );
  }

  getMessageByPixel(pixelId: string): Promise<MessageRow | undefined> {
    return this.db.get<MessageRow>('SELECT * FROM messages WHERE pixel_id = ?', pixelId);
  }

  async getLinkWithMessage(
    linkId: string,
  ): Promise<{ link: LinkRow; message: MessageRow } | undefined> {
    const link = await this.db.get<LinkRow>('SELECT * FROM links WHERE id = ?', linkId);
    if (!link) return undefined;
    const message = await this.db.get<MessageRow>(
      'SELECT * FROM messages WHERE id = ?',
      link.message_id,
    );
    return message ? { link, message } : undefined;
  }

  async bindMessage(
    userId: string,
    id: string,
    patch: { gmailThreadId?: string; gmailMessageId?: string; repliedAt?: number },
  ): Promise<boolean> {
    const r = await this.db.run(
      `UPDATE messages SET
         gmail_thread_id = COALESCE(?, gmail_thread_id),
         gmail_message_id = COALESCE(?, gmail_message_id),
         replied_at = COALESCE(replied_at, ?)
       WHERE id = ? AND user_id = ?`,
      patch.gmailThreadId ?? null,
      patch.gmailMessageId ?? null,
      patch.repliedAt ?? null,
      id,
      userId,
    );
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
  ): Promise<MessageRow[]> {
    const where = ['user_id = ?'];
    const params: SqlValue[] = [userId];
    if (f.account) {
      where.push('sender_account = ?');
      params.push(f.account);
    }
    if (f.accounts && f.accounts.length > 0) {
      where.push('sender_account IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(f.accounts));
    }
    if (f.since !== undefined) {
      where.push('sent_at >= ?');
      params.push(f.since);
    }
    if (f.threadIds && f.threadIds.length > 0) {
      where.push('gmail_thread_id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(f.threadIds));
    }
    if (f.q) {
      where.push(
        "(subject LIKE ? ESCAPE '\\' COLLATE NOCASE OR recipients_json LIKE ? ESCAPE '\\' COLLATE NOCASE)",
      );
      const like = `%${escapeLike(f.q)}%`;
      params.push(like, like);
    }
    params.push(f.limit);
    return this.db.all<MessageRow>(
      `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY sent_at DESC, id DESC LIMIT ?`,
      ...params,
    );
  }

  /** Aggregate open/click stats for message rows and build API summaries. */
  async summarize(rows: MessageRow[]): Promise<MessageSummary[]> {
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
    type Last = { message_id: string; type: EventType; occurred_at: number; ua_class: UaClass };
    type LinkAgg = LinkRow & { clicks: number; last_click: number | null };
    const [aggs, lasts, links] = await Promise.all([
      this.db.all<Agg>(
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
        ids,
      ),
      this.db.all<Last>(
        `SELECT message_id, type, occurred_at, ua_class FROM (
           SELECT message_id, type, occurred_at, ua_class,
             ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY occurred_at DESC, id DESC) AS rn
           FROM events
           WHERE message_id IN (SELECT value FROM json_each(?)) AND ua_class NOT IN ('bot','sender')
         ) WHERE rn = 1`,
        ids,
      ),
      this.db.all<LinkAgg>(
        `SELECT l.id, l.message_id, l.original_url, l.position,
           COUNT(e.id) AS clicks, MAX(e.occurred_at) AS last_click
         FROM links l
         LEFT JOIN events e ON e.link_id = l.id AND e.type = 'click' AND e.ua_class IN (${CLICK_IN})
         WHERE l.message_id IN (SELECT value FROM json_each(?))
         GROUP BY l.id ORDER BY l.position`,
        ids,
      ),
    ]);
    const aggBy = new Map(aggs.map((a) => [a.message_id, a]));
    const lastBy = new Map(lasts.map((l) => [l.message_id, l]));
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

  async hasRecentDuplicate(e: {
    message_id: string;
    link_id: string | null;
    type: EventType;
    ip_hash: string;
    ua_class: UaClass;
    after: number;
  }): Promise<boolean> {
    const row = await this.db.get(
      `SELECT 1 AS x FROM events WHERE message_id = ? AND type = ?
         AND link_id IS ? AND ip_hash = ? AND ua_class = ?
         AND occurred_at >= ? LIMIT 1`,
      e.message_id,
      e.type,
      e.link_id,
      e.ip_hash,
      e.ua_class,
      e.after,
    );
    return row !== undefined;
  }

  /** Statements that set is_first=1 on the earliest counted event (per message for opens, per link for clicks). */
  private static recomputeFirstStmts(
    messageId: string,
    type: EventType,
    linkId: string | null,
  ): Stmt[] {
    const counted = type === 'open' ? OPEN_IN : CLICK_IN;
    const linkClause = type === 'click' ? 'AND link_id IS ?' : '';
    const base: SqlValue[] = type === 'click' ? [messageId, type, linkId] : [messageId, type];
    return [
      stmt(
        `UPDATE events SET is_first = 0 WHERE message_id = ? AND type = ? ${linkClause}`,
        ...base,
      ),
      stmt(
        `UPDATE events SET is_first = 1 WHERE id = (
           SELECT id FROM events WHERE message_id = ? AND type = ? ${linkClause}
             AND ua_class IN (${counted})
           ORDER BY occurred_at ASC, id ASC LIMIT 1)`,
        ...base,
      ),
    ];
  }

  /** Insert an event and recompute first-event flags atomically. Returns the new event id. */
  async insertEvent(e: Omit<EventRow, 'id'>): Promise<number> {
    const [ins] = await this.db.batch([
      stmt(
        `INSERT INTO events(message_id, link_id, type, occurred_at, ip_hash, ua_class, is_first)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        e.message_id,
        e.link_id,
        e.type,
        e.occurred_at,
        e.ip_hash,
        e.ua_class,
        e.is_first,
      ),
      ...Repo.recomputeFirstStmts(e.message_id, e.type, e.link_id),
    ]);
    return ins?.lastRowId ?? 0;
  }

  async hasSelfViewNear(
    messageId: string,
    account: string,
    at: number,
    windowMs: number,
  ): Promise<boolean> {
    const row = await this.db.get(
      `SELECT 1 AS x FROM self_views WHERE message_id = ? AND account = ?
         AND viewed_at BETWEEN ? AND ? LIMIT 1`,
      messageId,
      account,
      at - windowMs,
      at + windowMs,
    );
    return row !== undefined;
  }

  /**
   * Record a self-view and reclassify Gmail-proxy opens within ±window as the sender's own,
   * atomically. Returns how many events were reclassified.
   */
  async recordSelfView(
    messageId: string,
    account: string,
    at: number,
    windowMs: number,
  ): Promise<number> {
    const [, reclass] = await this.db.batch([
      stmt(
        'INSERT INTO self_views(message_id, account, viewed_at) VALUES (?, ?, ?)',
        messageId,
        account,
        at,
      ),
      stmt(
        `UPDATE events SET ua_class = 'sender', is_first = 0
         WHERE message_id = ? AND type = 'open' AND ua_class = 'gmail_proxy'
           AND occurred_at BETWEEN ? AND ?`,
        messageId,
        at - windowMs,
        at + windowMs,
      ),
      ...Repo.recomputeFirstStmts(messageId, 'open', null),
    ]);
    return reclass?.changes ?? 0;
  }

  eventsForMessage(userId: string, messageId: string): Promise<TrackingEvent[]> {
    return this.eventQuery('m.user_id = ? AND e.message_id = ? ORDER BY e.id ASC', [
      userId,
      messageId,
    ]);
  }

  /** Events for polling: id > cursor, optionally filtered by account, ordered by id. */
  eventsAfter(
    userId: string,
    f: { cursor?: number; since?: number; account?: string; limit: number },
  ): Promise<TrackingEvent[]> {
    const where = ['m.user_id = ?'];
    const params: SqlValue[] = [userId];
    if (f.cursor !== undefined) {
      where.push('e.id > ?');
      params.push(f.cursor);
    }
    if (f.since !== undefined) {
      where.push('e.occurred_at >= ?');
      params.push(f.since);
    }
    if (f.account) {
      where.push('m.sender_account = ?');
      params.push(f.account);
    }
    params.push(f.limit);
    return this.eventQuery(`${where.join(' AND ')} ORDER BY e.id ASC LIMIT ?`, params);
  }

  async maxEventIdForUser(userId: string): Promise<number> {
    const row = await this.db.get<{ id: number | null }>(
      'SELECT MAX(e.id) AS id FROM events e JOIN messages m ON m.id = e.message_id WHERE m.user_id = ?',
      userId,
    );
    return row?.id ?? 0;
  }

  private async eventQuery(whereAndOrder: string, params: SqlValue[]): Promise<TrackingEvent[]> {
    type Row = EventRow & {
      sender_account: string;
      subject: string;
      recipients_json: string;
      gmail_thread_id: string | null;
      original_url: string | null;
    };
    const rows = await this.db.all<Row>(
      `SELECT e.*, m.sender_account, m.subject, m.recipients_json, m.gmail_thread_id, l.original_url
       FROM events e
       JOIN messages m ON m.id = e.message_id
       LEFT JOIN links l ON l.id = e.link_id
       WHERE ${whereAndOrder}`,
      ...params,
    );
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

  // ---------- retention ----------

  /**
   * Housekeeping. Self-view beacons are only useful for ±20 s, so drop them after a day.
   * With `retentionDays > 0`, also delete messages (and, by cascade, their links, events and
   * reminders) older than that.
   */
  async purge(
    now: number,
    retentionDays: number,
  ): Promise<{ selfViews: number; messages: number }> {
    const selfViews = (
      await this.db.run('DELETE FROM self_views WHERE viewed_at < ?', now - 86_400_000)
    ).changes;
    const messages =
      retentionDays > 0
        ? (
            await this.db.run(
              'DELETE FROM messages WHERE sent_at < ?',
              now - retentionDays * 86_400_000,
            )
          ).changes
        : 0;
    return { selfViews, messages };
  }

  // ---------- accounts ----------

  async accounts(userId: string): Promise<AccountInfo[]> {
    const [rows, userSettings] = await Promise.all([
      this.db.all<{ account: string; c: number; last: number }>(
        `SELECT sender_account AS account, COUNT(*) AS c, MAX(sent_at) AS last
         FROM messages WHERE user_id = ? GROUP BY sender_account`,
        userId,
      ),
      this.getUserSettings(userId),
    ]);
    const settings = userSettings.accounts ?? {};
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

  async insertReminder(r: ReminderRow): Promise<void> {
    await this.db.run(
      `INSERT INTO reminders(id, message_id, remind_at, condition, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      r.id,
      r.message_id,
      r.remind_at,
      r.condition,
      r.status,
      r.created_at,
    );
  }

  async listReminders(
    userId: string,
    f: { status?: ReminderStatus; account?: string; id?: string },
  ): Promise<Reminder[]> {
    const where = ['m.user_id = ?'];
    const params: SqlValue[] = [userId];
    if (f.status) {
      where.push('r.status = ?');
      params.push(f.status);
    }
    if (f.account) {
      where.push('m.sender_account = ?');
      params.push(f.account);
    }
    if (f.id) {
      where.push('r.id = ?');
      params.push(f.id);
    }
    type Row = ReminderRow & {
      subject: string;
      recipients_json: string;
      sender_account: string;
      gmail_thread_id: string | null;
    };
    const rows = await this.db.all<Row>(
      `SELECT r.*, m.subject, m.recipients_json, m.sender_account, m.gmail_thread_id
       FROM reminders r JOIN messages m ON m.id = r.message_id
       WHERE ${where.join(' AND ')} ORDER BY r.remind_at ASC`,
      ...params,
    );
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

  async updateReminderStatus(userId: string, id: string, status: ReminderStatus): Promise<boolean> {
    const r = await this.db.run(
      `UPDATE reminders SET status = ? WHERE id = ? AND message_id IN
         (SELECT id FROM messages WHERE user_id = ?)`,
      status,
      id,
      userId,
    );
    return r.changes > 0;
  }

  async deleteReminder(userId: string, id: string): Promise<boolean> {
    const r = await this.db.run(
      `DELETE FROM reminders WHERE id = ? AND message_id IN
         (SELECT id FROM messages WHERE user_id = ?)`,
      id,
      userId,
    );
    return r.changes > 0;
  }

  /** Test/debug helper: raw rows of a table. */
  rawAll<T>(sql: string): Promise<T[]> {
    return this.db.all<T>(sql);
  }
}
