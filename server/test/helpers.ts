import { createApp } from '../src/app';
import { openDb } from '../src/db/db';
import { loadEnv } from '../src/env';
import { TokenBucketLimiter } from '../src/middleware/rateLimit';

export const BASE = 'http://pm.test';

export interface TestCtx {
  clock: { now: number };
  ip: { value: string };
  app: ReturnType<typeof createApp>['app'];
  repo: ReturnType<typeof createApp>['repo'];
  tracking: ReturnType<typeof createApp>['tracking'];
  req: (path: string, init?: RequestInit & { token?: string; json?: unknown }) => Promise<Response>;
  register: (email: string) => Promise<string>;
  advance: (ms: number) => void;
}

export function makeCtx(envOverrides: Record<string, string> = {}, generousLimits = true): TestCtx {
  const db = openDb(':memory:');
  const env = loadEnv({
    PUBLIC_BASE_URL: BASE,
    IP_HASH_SALT: 'test-salt-0123456789',
    ...envOverrides,
  });
  const clock = { now: Date.parse('2026-03-01T12:00:00Z') };
  const ip = { value: '203.0.113.7' };
  const limiters = generousLimits
    ? {
        publicByIp: new TokenBucketLimiter(10_000, 1000),
        registerByIp: new TokenBucketLimiter(10_000, 1000),
        apiByUser: new TokenBucketLimiter(10_000, 1000),
      }
    : undefined;
  const created = createApp({
    db,
    env,
    now: () => clock.now,
    getSocketIp: () => ip.value,
    ...(limiters && { limiters }),
  });
  const req: TestCtx['req'] = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(init.json);
    }
    return Promise.resolve(created.app.request(`${BASE}${path}`, { ...init, headers, body }));
  };
  const register = async (email: string) => {
    const r = await req('/v1/auth/register', { method: 'POST', json: { email } });
    const j = (await r.json()) as { token: string };
    return j.token;
  };
  return {
    clock,
    ip,
    app: created.app,
    repo: created.repo,
    tracking: created.tracking,
    req,
    register,
    advance: (ms) => {
      clock.now += ms;
    },
  };
}

export const UA = {
  gmail:
    'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
  appleMail:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  bareMozilla: 'Mozilla/5.0',
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  outlook: 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17328; Pro)',
  curl: 'curl/8.4.0',
  proofpoint: 'Mozilla/5.0 (compatible; Proofpoint URL Defense)',
};

export async function createMessage(
  ctx: TestCtx,
  token: string,
  body: Partial<{
    senderAccount: string;
    subject: string;
    recipients: string[];
    links: string[];
    clientRequestId: string;
  }> = {},
) {
  const r = await ctx.req('/v1/messages', {
    method: 'POST',
    token,
    json: {
      senderAccount: 'me@work.com',
      subject: 'Hello',
      recipients: ['you@example.com'],
      links: ['https://example.com/a'],
      ...body,
    },
  });
  if (r.status !== 201 && r.status !== 200)
    throw new Error(`create failed ${r.status} ${await r.text()}`);
  return (await r.json()) as {
    messageId: string;
    pixelId: string;
    pixelUrl: string;
    rewrittenLinks: { original: string; trackedUrl: string; linkId: string }[];
  };
}

export async function pixel(ctx: TestCtx, pixelId: string, ua: string, query = '') {
  return ctx.req(`/p/${pixelId}.gif${query}`, { headers: { 'User-Agent': ua } });
}
