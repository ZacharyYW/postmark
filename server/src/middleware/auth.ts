import type { MiddlewareHandler } from 'hono';
import type { Repo } from '../db/repo';
import { sha256Hex } from '../lib/crypto';
import { ApiHttpError, type AppEnv } from '../http';
import type { TokenBucketLimiter } from './rateLimit';

export function requireAuth(repo: Repo, limiter: TokenBucketLimiter): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header);
    if (!m?.[1])
      throw new ApiHttpError(401, 'UNAUTHENTICATED', 'Missing or malformed bearer token');
    const user = await repo.findUserByTokenHash(sha256Hex(m[1]));
    if (!user) throw new ApiHttpError(401, 'UNAUTHENTICATED', 'Invalid token');
    if (!limiter.take(`u:${user.id}`)) {
      c.header('Retry-After', String(limiter.retryAfter(`u:${user.id}`)));
      throw new ApiHttpError(429, 'RATE_LIMITED', 'Too many requests');
    }
    c.set('user', user);
    await next();
  };
}
