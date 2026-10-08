import { randomToken } from '../lib/crypto';
import type { SqlDb } from './sql';

/** Read a meta value, creating it with `init()` on first use (per-install salt / secret). */
export async function getOrInitMeta(db: SqlDb, key: string, init: () => string): Promise<string> {
  const row = await db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
  if (row) return row.value;
  // INSERT OR IGNORE + re-read is race-safe across concurrent cold starts.
  await db.run('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)', key, init());
  const again = await db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
  if (!again) throw new Error(`meta ${key} missing after insert`);
  return again.value;
}

export interface InstallSecrets {
  ipSalt: string;
  signSecret: string;
}

export async function loadSecrets(db: SqlDb, fixedSalt?: string): Promise<InstallSecrets> {
  return {
    ipSalt: fixedSalt ?? (await getOrInitMeta(db, 'ip_salt', () => randomToken(24))),
    signSecret: await getOrInitMeta(db, 'sign_secret', () => randomToken(32)),
  };
}
