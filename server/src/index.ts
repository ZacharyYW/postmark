import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app';
import { openDb } from './db/db';
import { loadEnv } from './env';

// Load .env (project root or server/) when present; real environment variables win.
for (const p of ['.env', '../.env']) {
  if (existsSync(p)) {
    const before = { ...process.env };
    process.loadEnvFile(p);
    Object.assign(process.env, before);
    console.log(`Loaded settings from ${resolve(p)}`);
    break;
  }
}
const env = loadEnv();
const db = openDb(env.DATABASE_PATH);
const log = (msg: string) => {
  if (env.LOG_LEVEL !== 'silent') console.error(`[postmark] ${msg}`);
};

if (!env.EXTENSION_IDS) {
  log('EXTENSION_IDS is empty: CORS accepts any chrome-extension:// origin (dev mode).');
}
if (env.DEV_ALLOW_TOKEN_ROTATION) {
  log('DEV_ALLOW_TOKEN_ROTATION is on: anyone can re-register an existing email. Dev only!');
}

const { app, repo } = createApp({
  db,
  env,
  log,
  getSocketIp: (c) => {
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined;
    }
  },
});

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`Postmark server listening on http://${info.address}:${info.port}`);
  console.log(`Public base URL: ${env.PUBLIC_BASE_URL}`);
});

const housekeeping = () => {
  try {
    const r = repo.purge(Date.now(), env.RETENTION_DAYS);
    if (r.messages > 0)
      log(`retention: deleted ${r.messages} messages older than ${env.RETENTION_DAYS} days`);
  } catch (err) {
    log(`housekeeping failed: ${(err as Error).message}`);
  }
};
housekeeping();
const housekeepingTimer = setInterval(housekeeping, 6 * 3_600_000);
housekeepingTimer.unref();

const shutdown = () => {
  clearInterval(housekeepingTimer);
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
