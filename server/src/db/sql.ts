/**
 * Minimal async SQL interface implemented by both runtimes:
 *  - `sqliteDb`: better-sqlite3 (Node server, Docker, tests)
 *  - `d1Db`: Cloudflare D1 (Workers deployment)
 * Only positional `?` parameters are used (D1 does not support named parameters).
 */

export type SqlValue = string | number | null;

export interface Stmt {
  sql: string;
  params: SqlValue[];
}

export interface RunResult {
  changes: number;
  lastRowId: number;
}

export interface SqlDb {
  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  get<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  run(sql: string, ...params: SqlValue[]): Promise<RunResult>;
  /** Execute statements in order, atomically (all succeed or none apply). */
  batch(stmts: Stmt[]): Promise<RunResult[]>;
}

export const stmt = (sql: string, ...params: SqlValue[]): Stmt => ({ sql, params });

// ---------- better-sqlite3 ----------

interface BetterSqlite {
  prepare(sql: string): {
    all(...p: SqlValue[]): unknown[];
    get(...p: SqlValue[]): unknown;
    run(...p: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  };
  transaction<F extends (...a: never[]) => unknown>(fn: F): F;
}

export function sqliteDb(db: BetterSqlite): SqlDb {
  const run = (sql: string, params: SqlValue[]): RunResult => {
    const r = db.prepare(sql).run(...params);
    return { changes: r.changes, lastRowId: Number(r.lastInsertRowid) };
  };
  return {
    async all<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    async get<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    async run(sql, ...params) {
      return run(sql, params);
    },
    async batch(stmts) {
      return db.transaction(() => stmts.map((s) => run(s.sql, s.params)))();
    },
  };
}

// ---------- Cloudflare D1 ----------

/** The subset of Cloudflare's D1Database type we use (avoids a types dependency). */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
  batch(stmts: D1StmtLike[]): Promise<{ meta: { changes?: number; last_row_id?: number } }[]>;
}
interface D1StmtLike {
  bind(...values: SqlValue[]): D1StmtLike;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number; last_row_id?: number } }>;
}

export function d1Db(d1: D1Like): SqlDb {
  const prep = (sql: string, params: SqlValue[]) =>
    params.length > 0 ? d1.prepare(sql).bind(...params) : d1.prepare(sql);
  const toRun = (meta: { changes?: number; last_row_id?: number }): RunResult => ({
    changes: meta.changes ?? 0,
    lastRowId: meta.last_row_id ?? 0,
  });
  return {
    async all<T>(sql: string, ...params: SqlValue[]) {
      return (await prep(sql, params).all<T>()).results;
    },
    async get<T>(sql: string, ...params: SqlValue[]) {
      return (await prep(sql, params).first<T>()) ?? undefined;
    },
    async run(sql, ...params) {
      return toRun((await prep(sql, params).run()).meta);
    },
    async batch(stmts) {
      if (stmts.length === 0) return [];
      const res = await d1.batch(stmts.map((s) => prep(s.sql, s.params)));
      return res.map((r) => toRun(r.meta));
    },
  };
}
