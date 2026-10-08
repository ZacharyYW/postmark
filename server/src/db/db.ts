import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL } from './schema';
import { sqliteDb, type SqlDb } from './sql';

/** Open (and migrate) a local SQLite database for the Node server and tests. */
export function openDb(path: string): SqlDb & { close(): void } {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  // better-sqlite3's statement typings are stricter than our positional SqlValue[] calls.
  return Object.assign(sqliteDb(db as unknown as Parameters<typeof sqliteDb>[0]), {
    close: () => db.close(),
  });
}
