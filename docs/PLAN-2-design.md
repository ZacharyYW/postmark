# PLAN-2 — Detailed design

> Amended in P3: amendments are marked **[P3-Fn]**, pointing at the numbered flaw in `PLAN-3-tasks.md`.

## 1. Repository tree

```
/package.json              npm workspaces: shared, server, extension; scripts: verify, typecheck, lint, test, build, seed, simulate
/tsconfig.base.json        strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes=false
/eslint.config.js          flat config: @eslint/js + typescript-eslint + prettier
/.prettierrc  /.env.example  /docker-compose.yml  /README.md
/scripts/seed.ts           seeds 1 user, 2 sender accounts, messages, links, events, reminders
/scripts/simulate-open.ts  hits /p and /l with Gmail-proxy, Apple-MPP, bot, sender and plain UAs
/shared/src/
    constants.ts   UA_CLASSES, EVENT_TYPES, REMINDER_CONDITIONS, timing constants
    schemas.ts     zod schemas for every API request/response
    settings.ts    settings types + resolveSettings() precedence resolver
    accounts.ts    normalizeAccount(), isValidAccount()
    urls.ts        isTrackableHref(), gmailThreadUrl()
    bus.ts         message-bus type map (BusMap) + envelope types
    index.ts
/server/src/
    env.ts         zod-parsed env
    index.ts       node entry (serve)
    app.ts         createApp({db, env, clock}) → Hono
    db/schema.sql  DDL     db/db.ts  openDb(path) → migrate → meta (salt, secret)
    db/repo.ts     all SQL (prepared statements), typed results
    tracking/classify.ts  classifyOpen(), classifyClick(), pure
    tracking/cidr.ts      ipInCidrs()
    tracking/record.ts    recordOpen()/recordClick(): classify → dedupe → insert → recompute firsts
    tracking/gif.ts       43-byte GIF buffer
    middleware/auth.ts rateLimit.ts cors.ts
    routes/auth.ts messages.ts accounts.ts events.ts reminders.ts me.ts public.ts
    lib/ids.ts (nanoid 21)  lib/hash.ts (sha256, hmac)  lib/ip.ts (client ip)
/server/test/*.test.ts
/extension/
    manifest.config.ts  vite.config.ts  index.html (popup)  options.html
    public/icons/*.png  public/pageWorld.js (copied at build from @inboxsdk/core)
    src/background/index.ts  api.ts  auth.ts  settings.ts  tabAccounts.ts  poll.ts  notify.ts  reminders.ts  handlers.ts
    src/bus/client.ts  router.ts
    src/gmail/adapter.ts  inboxsdkAdapter.ts  compose.ts  listMarks.ts  threadStrip.ts  shadow.ts  safe.ts  content.ts
    src/compose/rewriteBody.ts
    src/ui/components/*.tsx  ui/popup/*.tsx  ui/options/*.tsx  ui/styles/*.module.css  ui/format.ts
/extension/test/*.test.ts(x)
/docs/*
```

Module boundary rules:
* Only `gmail/inboxsdkAdapter.ts` imports `@inboxsdk/core`.
* Only `background/api.ts` calls `fetch`.
* `/shared` has no runtime deps besides zod.

## 2. Shared types (zod)

```ts
// constants.ts
export const UA_CLASSES = ['gmail_proxy','apple_mpp','sender','bot','other'] as const;
export const EVENT_TYPES = ['open','click'] as const;
export const REMINDER_CONDITIONS = ['no_open','no_reply','always'] as const;
export const REMINDER_STATUSES = ['pending','fired','satisfied','cancelled'] as const;
export const TIMING = { SELF_OPEN_GRACE_MS: 10_000, SELF_VIEW_WINDOW_MS: 20_000, DEDUPE_WINDOW_MS: 30_000,
  MPP_PREFETCH_WINDOW_MS: 120_000, CLICK_SCANNER_WINDOW_MS: 10_000, EVENT_SETTLE_MS: 20_000, PRESEND_TIMEOUT_MS: 3_000 };
export const COUNTED_OPEN_CLASSES = ['gmail_proxy','other']; // counted toward "opens" / notifications
export const COUNTED_CLICK_CLASSES = ['gmail_proxy','other'];

// schemas.ts (abridged; the code is authoritative)
Account        = z.string().trim().toLowerCase().email().max(254)
RegisterReq    = { email: Email }                                    → RegisterRes { token, userId, email }
CreateMessageReq = { senderAccount: Account, subject: string≤998, recipients: Email[]≤100 (1+),
                     links: HttpUrl[]≤200, clientRequestId?: string≤128 }        [P3-F1]
CreateMessageRes = { messageId, pixelId, pixelUrl, rewrittenLinks: { original, trackedUrl, linkId }[] }
BindMessageReq = { gmailThreadId?: string, gmailMessageId?: string, repliedAt?: iso }   (≥1 field)  [P3-F12]
OpenStats   = { total, unique, autoLoaded, first: iso|null, last: iso|null }
LinkStats   = { id, originalUrl, position, clicks, lastClick: iso|null }
MessageSummary = { id, senderAccount, gmailThreadId|null, gmailMessageId|null, subject, recipients[],
                   sentAt, trackingEnabled, repliedAt|null, opens: OpenStats, clicks: {total,last},
                   links: LinkStats[], lastEvent: {type, occurredAt, uaClass}|null,
                   status: 'sent'|'opened'|'auto_loaded'|'clicked' }
ListMessagesQuery = { since?: iso, limit?: 1..200 (50), account?: Account, threadIds?: csv≤100, q?: string≤200 }
TrackingEvent  = { id:number, messageId, linkId|null, type, occurredAt, uaClass, isFirst, senderAccount,
                   subject, gmailThreadId|null, linkUrl|null }
EventsQuery    = { cursor?: int string, since?: iso, account?: Account, limit?: 1..500 (200) }
EventsRes      = { events: TrackingEvent[], cursor: string }                         [P3-F6]
AccountSettings = { trackingDefault?: boolean, notificationsEnabled?: boolean, quietHours?: QuietHours|null }
AccountInfo    = { account, messageCount, lastSentAt|null, settings: AccountSettings }
QuietHours     = { start: 'HH:MM', end: 'HH:MM' }   (local time; start>end wraps midnight)
CreateReminderReq = { messageId, remindAt: iso (future, ≤ 365 d), condition }
Reminder       = { id, messageId, remindAt, condition, status, createdAt, subject, senderAccount, gmailThreadId }
SelfViewReq    = { account: Account }
```

### Settings precedence (`shared/settings.ts`)

```ts
type GlobalSettings = { trackingDefault: boolean; notifyFirstOpen: boolean; notifyClick: boolean;
  notifyReminders: boolean; disclosureFooter: boolean; quietHours: QuietHours|null; };
const BUILTIN_DEFAULTS: GlobalSettings = { trackingDefault:true, notifyFirstOpen:true, notifyClick:true,
  notifyReminders:true, disclosureFooter:false, quietHours:null };
resolveSettings(account?: AccountSettings, global?: Partial<GlobalSettings>): ResolvedSettings
// trackingDefault:  account.trackingDefault ?? global.trackingDefault ?? builtin
// notifications:    account.notificationsEnabled === false ⇒ all off for that account; else per-type global ?? builtin
// quietHours:       account.quietHours !== undefined ? account.quietHours : global.quietHours ?? null
```

Global settings live in `chrome.storage.local` (`settings.global`). Per-account settings live on the server in `users.settings_json.accounts[account]` (spec 5.2) and are cached in `chrome.storage.local` (`cache.accounts`).

## 3. SQL DDL

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);       -- ip_salt, sign_secret, schema_version
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, settings_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_account TEXT NOT NULL, gmail_thread_id TEXT, gmail_message_id TEXT,
  subject TEXT NOT NULL, recipients_json TEXT NOT NULL, sent_at INTEGER NOT NULL,
  tracking_enabled INTEGER NOT NULL DEFAULT 1, pixel_id TEXT NOT NULL UNIQUE,
  client_request_id TEXT, replied_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_messages_user_acct_sent ON messages(user_id, sender_account, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_thread ON messages(user_id, gmail_thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_req ON messages(user_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  original_url TEXT NOT NULL, position INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_links_message ON links(message_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  link_id TEXT REFERENCES links(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('open','click')), occurred_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL, ua_class TEXT NOT NULL CHECK (ua_class IN ('gmail_proxy','apple_mpp','sender','bot','other')),
  is_first INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_events_message ON events(message_id, type, occurred_at);
CREATE TABLE IF NOT EXISTS self_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account TEXT NOT NULL, viewed_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_self_views_message ON self_views(message_id, viewed_at);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  remind_at INTEGER NOT NULL, condition TEXT NOT NULL CHECK (condition IN ('no_open','no_reply','always')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fired','satisfied','cancelled')),
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reminders_message ON reminders(message_id);
```

Times are stored as epoch milliseconds (INTEGER) and serialised as ISO-8601 in JSON. Message ids, pixel ids and link ids are 21-char nanoids. Reminder ids are nanoids. Event ids are monotonic integers, which is what the cursor is built on.

## 4. API contract

| Method & path | Auth | Request | Response | Notes |
|---|---|---|---|---|
| `GET /healthz` | – | – | `{ok:true}` | |
| `POST /v1/auth/register` | – | `RegisterReq` | 201 `RegisterRes` | Existing email → 409 unless `DEV_ALLOW_TOKEN_ROTATION=true` **[P3-F4]**. Rate limit 5/min per IP. |
| `GET /v1/me` | Bearer | – | `{userId,email,createdAt}` | |
| `DELETE /v1/me` | Bearer | – | 204 | Cascades all rows. |
| `POST /v1/messages` | Bearer | `CreateMessageReq` | 201 `CreateMessageRes` (200 on idempotent replay) | Idempotent on `clientRequestId` while unbound; new URLs are appended. |
| `PATCH /v1/messages/:id` | Bearer | `BindMessageReq` | `MessageSummary` | 404 if not owned. |
| `GET /v1/messages` | Bearer | `ListMessagesQuery` | `{messages: MessageSummary[]}` | Ordered by `sent_at` desc. |
| `GET /v1/messages/:id` | Bearer | – | `MessageSummary` | |
| `GET /v1/messages/:id/events` | Bearer | – | `{events: TrackingEvent[]}` | Includes excluded classes, for transparency. |
| `POST /v1/messages/:id/self-view` | Bearer | `SelfViewReq` | 204 | Ignored unless `account === sender_account`. Reclassifies retroactively. |
| `GET /v1/accounts` | Bearer | – | `{accounts: AccountInfo[]}` | Includes accounts that exist only in settings (configured before any send). |
| `PATCH /v1/accounts/:account` | Bearer | `AccountSettings` | `AccountInfo` | Merge semantics; `null` clears a key. |
| `GET /v1/events` | Bearer | `EventsQuery` | `EventsRes` | Only *settled* events (older than 20 s), contiguous by id. |
| `POST /v1/reminders` | Bearer | `CreateReminderReq` | 201 `Reminder` | |
| `GET /v1/reminders` | Bearer | `?status=&account=` | `{reminders: Reminder[]}` | |
| `PATCH /v1/reminders/:id` | Bearer | `{status}` | `Reminder` | Used by the SW to mark fired/satisfied. |
| `DELETE /v1/reminders/:id` | Bearer | – | 204 | |
| `GET /p/:pixelId.gif` | public | `?s=` optional | 200 GIF, always | `no-store`; records the open unless rate-limited. Unknown id → still GIF, nothing recorded. |
| `GET /l/:linkId` | public | `?s=` optional | 302 to `original_url` | Unknown id → 404 HTML page. Non-http(s) stored URL → 400. Rate-limited → still redirect, not recorded. |

Errors are always `{error: {code, message, issues?}}`, with status codes 400/401/403/404/409/413/429.

## 5. Open/click classification and recording

`classifyOpen({ua, ip, msSinceSent, senderSig, mppCidrs}) → UaClass` (pure), in this order:
1. `senderSig` valid, or `msSinceSent < 10 s` → `sender`
2. `ua` matches `GoogleImageProxy` or `via ggpht.com` → `gmail_proxy`
3. Scanner/bot signature regex → `bot`. An empty UA is also `bot`.
4. IP in Apple MPP CIDRs, or UA exactly `Mozilla/5.0`, or (Apple-Mail-shaped UA: `AppleWebKit` without `Safari|Chrome|Firefox|Edg`, and `msSinceSent < 120 s`) → `apple_mpp`
5. otherwise `other`

`classifyClick`: same sender rule; bot signatures; `msSinceSent < 10 s` → `bot` (link scanners) **[P3-F10]**; otherwise `other`.

`recordEvent` runs in one transaction:
1. Look up the message.
2. Classify.
3. If a self-view exists within ±20 s from the same sender account and the class is `gmail_proxy`, reclassify to `sender`.
4. Dedupe: the same (message, type, link, ip_hash, ua_class) within 30 s → no insert.
5. Insert.
6. `recomputeFirst(message, type, link)`: `is_first=1` on the earliest counted event (first open per message; first click per link), 0 elsewhere.

`selfView(messageId, account)`:
1. Insert into `self_views`.
2. Update `gmail_proxy` opens within ±20 s → `sender`.
3. Recompute firsts.

## 6. Message bus (`shared/bus.ts`)

Envelope: `{ type: K, payload: BusMap[K]['req'] }`. Response: `{ ok: true, data: BusMap[K]['res'] } | { ok: false, error: { code: BusErrorCode, message } }`.
Error codes: `NOT_AUTHENTICATED | NETWORK | TIMEOUT | SERVER | VALIDATION | NO_ACCOUNT | UNKNOWN`.

| Type | From | Request | Response |
|---|---|---|---|
| `ACTIVE_ACCOUNT` | content | `{account}` | `{ok:true}`. SW stores `tabId → account` from `sender.tab.id`. |
| `PREPARE_TRACKING` | content | `{clientRequestId, senderAccount, subject, recipients, links}` | `CreateMessageRes` |
| `BIND_SENT` | content | `{messageId, gmailThreadId, gmailMessageId}` | `{ok:true}` |
| `GET_MARKS` | content | `{threadIds}` | `{marks: Record<threadId, MessageSummary[]>}`. Account comes from the tab map. |
| `GET_THREAD_TRACKING` | content | `{threadId}` | `{messages: MessageSummary[]}` (account from tab map) |
| `SELF_VIEW` | content | `{messageId}` | `{ok:true}` (account from tab map) |
| `REPORT_REPLY` | content | `{messageId}` | `{ok:true}` |
| `GET_SETTINGS` | any | `{account?}` | `{global, account?, resolved}` |
| `UPDATE_GLOBAL_SETTINGS` | options/popup | `Partial<GlobalSettings>` | `GlobalSettings` |
| `UPDATE_ACCOUNT_SETTINGS` | options | `{account, settings}` | `AccountInfo` |
| `GET_AUTH_STATE` | popup/options | – | `{loggedIn, email?, serverUrl}` |
| `REGISTER` | options/popup | `{email, serverUrl?}` | `{email}` |
| `LOGOUT` | options | – | `{ok:true}` |
| `DELETE_ME` | options | – | `{ok:true}` |
| `SET_SERVER_URL` | options | `{serverUrl}` | `{serverUrl}` |
| `LIST_MESSAGES` | popup | `{account?, limit?, q?}` | `{messages}` |
| `LIST_ACCOUNTS` | popup/options | – | `{accounts: AccountInfo[], known: string[]}` |
| `LIST_REMINDERS` | popup | `{account?}` | `{reminders}` |
| `CREATE_REMINDER` | content | `{messageId, remindAt, condition}` | `Reminder`. SW also creates the alarm. |
| `DELETE_REMINDER` | popup | `{id}` | `{ok:true}` |
| `GET_ACTIVE_TAB_ACCOUNT` | popup | – | `{account: string \| null}` |
| `OPEN_THREAD` | popup | `{gmailThreadId, account}` | `{ok:true}` |
| `DATA_UPDATED` | SW → content (push via `tabs.sendMessage`) | `{messageIds, threadIds}` | – |

The tab→account map is stored in `chrome.storage.session` under `tabAccounts`, and cleaned on `tabs.onRemoved`. Content-script handlers ignore any `account` in the payload: the SW uses the map. **[P3-F14]**

## 7. Compose-send sequence

```mermaid
sequenceDiagram
  participant U as User
  participant C as Content script (compose.ts)
  participant S as InboxSDK (page world)
  participant W as Service worker
  participant API as Server
  U->>C: opens compose
  C->>W: GET_SETTINGS{account}
  C->>S: addButton(eye), registerRequestModifier(fn)
  U->>S: clicks Send
  S-->>C: presending (sync: snapshot from/subject/recipients)
  S->>C: modifier({body,isPlainText}) (awaited)
  alt tracking off / plain text / no account / body already has Postmark pixel
    C-->>S: {body} unchanged
  else
    C->>C: split fresh vs quoted; collect eligible links
    C->>W: PREPARE_TRACKING (timeout 3 s)
    W->>API: POST /v1/messages {clientRequestId}
    API-->>W: {messageId,pixelUrl,rewrittenLinks}
    W-->>C: data
    C->>C: rewrite hrefs (fresh part only), insert pixel before quote, optional footer
    C-->>S: {body: rewritten}
  end
  Note over C,S: any error or timeout → original body + toast "Sent without tracking"
  S->>S: Gmail send XHR with modified body
  S-->>C: sent{getThreadID(),getMessageID()}
  C->>W: BIND_SENT
  W->>API: PATCH /v1/messages/:id
  W-->>W: schedule poll soon
```

## 8. `rewriteBody` (extension/src/compose/rewriteBody.ts, pure)

```ts
export interface RewriteInput { html: string; trackingOrigin: string; }
export function hasPostmarkPixel(html, trackingOrigin): boolean
export function splitQuoted(doc: Document): { freshRoot: Element; quoteStart: Element | null }
  // first of: .gmail_quote, .gmail_quote_container, blockquote[type=cite], div.gmail_extra, #reply-intro-ish
export function collectLinks(html, trackingOrigin): string[]   // fresh portion only, de-duplicated in order
export function applyTracking(html, { trackingOrigin, pixelUrl, rewrittenLinks, footerHtml? }): string
```

* Eligible links are `http:`/`https:` only. Skip `mailto:`, `tel:`, `#...`, `javascript:`, relative URLs, URLs on the tracking origin, and links inside the quote.
* Hrefs are replaced through the DOM API (`setAttribute`), so attributes are escaped by the serializer. Link text and children are left untouched.
* The pixel is `<img src="…" width="1" height="1" style="display:none" alt="" data-postmark="1">`, inserted before `quoteStart`, or appended to the end of the fresh root if there is no quote.
* The footer is a `<div style="color:#888;font-size:11px">Read receipts enabled (Postmark)</div>`, inserted before the pixel.
* Signatures (`.gmail_signature`) count as fresh content. Their links are tracked.

## 9. UI state machines

**Compose toggle**: `init(default from resolved settings) → on ⇄ off` (click). Plus:
- `from changed → re-resolve the default only if the user hasn't touched the toggle` [P3-F8]
- `sent → done`
- `send failed → toast`

**List mark** per row: `unknown → (thread id) → loading → none | mark(sent | opened | auto_loaded | clicked)`. Updates in place on `DATA_UPDATED`. Rows from another account never resolve (the SW returns no marks).

**Thread strip** per message view:
- `pending → (message id + sender === tab account) → loading → tracked | untracked(hidden) | error(hidden + log)`
- `collapsed ⇄ expanded`, persisted in `chrome.storage.local` under `ui.stripCollapsed`.
- On entering `tracked`, send `SELF_VIEW` once per mount.

**Popup**: `boot → loggedOut | loading → ready(list) | empty | error | offline`.
- Tabs: Recent / Reminders. A Settings button opens the options page.
- Account switcher: `All | each account`. The initial value is the active Gmail tab's account if there is one, else the last selection, else All.

## 10. Polling, notifications, reminders

* Alarm `poll`: period 1 min if any tab is in the tab-account map, else 5 min. Re-evaluated on `ACTIVE_ACCOUNT` and `tabs.onRemoved`.
* `poll()`:
  1. `GET /v1/events?cursor=` → events.
  2. Group by `(messageId, type)` and filter on `isFirst` for opens. Each click is notifiable, batched per message.
  3. Apply resolved notification settings for the event's `senderAccount`, plus quiet hours.
  4. Create a notification `pm:<type>:<messageId>`, or queue it when quiet hours are on.
  5. Save the cursor.
  6. Broadcast `DATA_UPDATED` to Gmail tabs whose account matches.
* Notification text:
  - "Opened: ‹subject›", body "‹recipient› · via ‹account›". The "via" part appears only when >1 account is known.
  - Clicks: "Link clicked: ‹host›".
  - Clicking the notification opens `https://mail.google.com/mail/?authuser=<account>#all/<threadId>`.
* Reminders: on create, `chrome.alarms.create('rem:<id>', {when})`. When the alarm fires:
  1. `GET /v1/messages/:id`.
  2. Evaluate the condition: `no_open` → `opens.total === 0`; `no_reply` → `repliedAt === null`; `always` → true.
  3. Notify, or PATCH the reminder to `satisfied`. Mark it `fired` after notifying.
  4. On SW start, re-sync alarms from `GET /v1/reminders?status=pending`.
