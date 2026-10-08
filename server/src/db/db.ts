import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL } from './schema';
import { randomToken } from '../lib/crypto';

export type DB = Database.Database;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  return db;
}

/** Read a meta value, creating it with `init()` on first use (per-install salt / secret). */
export function getOrInitMeta(db: DB, key: string, init: () => string): string {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (row) return row.value;
  const value = init();
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(key, value);
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string }).value;
}

export interface InstallSecrets {
  ipSalt: string;
  signSecret: string;
}

export function loadSecrets(db: DB, fixedSalt?: string): InstallSecrets {
  return {
    ipSalt: fixedSalt ?? getOrInitMeta(db, 'ip_salt', () => randomToken(24)),
    signSecret: getOrInitMeta(db, 'sign_secret', () => randomToken(32)),
  };
}
