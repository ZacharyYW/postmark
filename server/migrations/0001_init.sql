-- Postmark schema v1 (kept identical to src/db/schema.ts; a test enforces this).
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_account TEXT NOT NULL,
  gmail_thread_id TEXT,
  gmail_message_id TEXT,
  subject TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  tracking_enabled INTEGER NOT NULL DEFAULT 1,
  pixel_id TEXT NOT NULL UNIQUE,
  client_request_id TEXT,
  replied_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user_acct_sent ON messages(user_id, sender_account, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_sent ON messages(user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_thread ON messages(user_id, gmail_thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_req
  ON messages(user_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  original_url TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_message ON links(message_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  link_id TEXT REFERENCES links(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('open','click')),
  occurred_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  ua_class TEXT NOT NULL CHECK (ua_class IN ('gmail_proxy','apple_mpp','sender','bot','other')),
  is_first INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_message ON events(message_id, type, occurred_at);

CREATE TABLE IF NOT EXISTS self_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  viewed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_views_message ON self_views(message_id, viewed_at);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  remind_at INTEGER NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('no_open','no_reply','always')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fired','satisfied','cancelled')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_message ON reminders(message_id);
