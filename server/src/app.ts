import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { Repo } from './db/repo';
import { loadSecrets } from './db/secrets';
import type { SqlDb } from './db/sql';
import type { Env } from './env';
import { ApiHttpError, type AppEnv } from './http';
import { hashIp } from './lib/crypto';
import { defaultLimiters, type Limiters } from './middleware/rateLimit';
import { apiRoutes } from './routes/api';
import { publicRoutes } from './routes/public';
import { normalizeIp, parseCidrList } from './tracking/cidr';
import type { TrackingContext } from './tracking/record';

export interface AppOptions {
  db: SqlDb;
  env: Env;
  now?: () => number;
  /** Override client-IP extraction (tests; the node entry passes socket info). */
  getSocketIp?: (c: Context<AppEnv>) => string | undefined;
  limiters?: Limiters;
  log?: (msg: string) => void;
}

export interface CreatedApp {
  app: Hono<AppEnv>;
  repo: Repo;
  tracking: TrackingContext;
}

const GMAIL_ORIGIN = 'https://mail.google.com';

export function isAllowedOrigin(origin: string, extensionIds: string[]): boolean {
  if (origin === GMAIL_ORIGIN) return true;
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (!m?.[1]) return false;
  return extensionIds.length === 0 || extensionIds.includes(m[1]);
}

export function createApp(opts: AppOptions): CreatedApp {
  const { db, env } = opts;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const repo = new Repo(db);
  let secretsP: ReturnType<typeof loadSecrets> | null = null;
  const secrets = () => {
    secretsP ??= loadSecrets(db, env.IP_HASH_SALT).catch((err: unknown) => {
      secretsP = null; // retry on the next request
      throw err;
    });
    return secretsP;
  };
  const limiters = opts.limiters ?? defaultLimiters();
  const tracking: TrackingContext = {
    repo,
    secrets,
    mppCidrs: parseCidrList(env.APPLE_MPP_CIDRS),
  };
  const allowedEmails = env.ALLOWED_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const extensionIds = env.EXTENSION_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const getIp = (c: Context<AppEnv>): string => {
    if (env.TRUST_PROXY) {
      // The right-most entry was appended by our own reverse proxy; earlier entries are
      // client-controlled and could be spoofed to dodge rate limits or dedupe.
      const fwd = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
      if (fwd) return normalizeIp(fwd);
    }
    return normalizeIp(opts.getSocketIp?.(c) ?? 'unknown');
  };

  const app = new Hono<AppEnv>();

  app.use(
    '*',
    secureHeaders({
      crossOriginResourcePolicy: 'cross-origin', // pixels are embedded by third-party mail clients
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      referrerPolicy: 'no-referrer',
    }),
  );

  // Hash the IP once per request; raw IPs never leave this middleware (and are never stored).
  app.use('*', async (c, next) => {
    c.set('ipHash', hashIp(getIp(c), (await secrets()).ipSalt));
    await next();
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  // Public routes: no CORS restrictions needed (images / top-level navigations).
  app.route(
    '/',
    publicRoutes({
      tracking,
      limiter: limiters.publicByIp,
      resourceLimiter: limiters.publicByResource,
      now,
      getIp,
      log,
    }),
  );

  app.use(
    '/v1/*',
    cors({
      origin: (origin) => (isAllowedOrigin(origin, extensionIds) ? origin : null),
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );
  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) =>
        c.json({ error: { code: 'TOO_LARGE', message: 'Request body too large' } }, 413),
    }),
  );
  app.route(
    '/v1',
    apiRoutes({
      repo,
      limiters,
      tracking,
      // Explicit PUBLIC_BASE_URL wins; otherwise use the request's own origin (Workers: the
      // permanent *.workers.dev / custom-domain URL, with no configuration needed).
      publicBaseUrl: (c) => env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin,
      allowedEmails,
      allowTokenRotation: env.DEV_ALLOW_TOKEN_ROTATION,
      now,
    }),
  );

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));

  app.onError((err, c) => {
    if (err instanceof ApiHttpError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.issues !== undefined && { issues: err.issues }),
          },
        },
        err.status,
      );
    }
    // Never echo internals; log without request bodies or tokens.
    log(`unhandled error on ${c.req.method} ${c.req.routePath}: ${err.message}`);
    return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
  });

  return { app, repo, tracking };
}
