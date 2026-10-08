import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app';
import { openDb } from './db/db';
import { loadEnv } from './env';

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

const { app } = createApp({
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

const shutdown = () => {
  server.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
