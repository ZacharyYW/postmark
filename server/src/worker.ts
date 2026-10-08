/**
 * Cloudflare Workers entry point. Same Hono app as the Node server (`index.ts`), backed by
 * Cloudflare D1 instead of better-sqlite3. Deploy with `npm run deploy:cloudflare`.
 */
import { createApp, type CreatedApp } from './app';
import { d1Db, type D1Like } from './db/sql';
import { loadEnv } from './env';

export interface WorkerEnv {
  DB: D1Like;
  [key: string]: unknown;
}

interface ScheduledCtx {
  waitUntil(p: Promise<unknown>): void;
}

let cached: { app: CreatedApp; db: D1Like } | null = null;

function getApp(env: WorkerEnv): CreatedApp {
  // One app per isolate (env bindings are stable for an isolate's lifetime).
  if (cached && cached.db === env.DB) return cached.app;
  const vars = Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
  const app = createApp({
    db: d1Db(env.DB),
    env: loadEnv(vars),
    // On Workers the client IP is provided by Cloudflare and cannot be spoofed by the client.
    getSocketIp: (c) => c.req.header('cf-connecting-ip') ?? undefined,
    log: (msg) => console.error(`[postmark] ${msg}`),
  });
  cached = { app, db: env.DB };
  return app;
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: unknown): Response | Promise<Response> {
    return getApp(env).app.fetch(request, env, ctx as never);
  },

  /** Cron trigger (see wrangler.toml): retention + self-view cleanup. */
  scheduled(_event: unknown, env: WorkerEnv, ctx: ScheduledCtx): void {
    const { repo } = getApp(env);
    const days = Number(env.RETENTION_DAYS ?? 0) || 0;
    ctx.waitUntil(repo.purge(Date.now(), days));
  },
};
