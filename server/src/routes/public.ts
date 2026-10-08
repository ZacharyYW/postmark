import { Hono, type Context } from 'hono';
import { ID_PATTERN, isHttpUrl } from '@postmark/shared';
import type { AppEnv } from '../http';
import type { TokenBucketLimiter } from '../middleware/rateLimit';
import { NO_STORE_HEADERS, TRANSPARENT_GIF } from '../tracking/gif';
import { recordClick, recordOpen, type TrackingContext } from '../tracking/record';

export interface PublicDeps {
  tracking: TrackingContext;
  limiter: TokenBucketLimiter;
  resourceLimiter: TokenBucketLimiter;
  now: () => number;
  getIp: (c: Context<AppEnv>) => string;
  log: (msg: string) => void;
}

const NOT_FOUND_HTML =
  '<!doctype html><meta charset="utf-8"><title>Link not found</title><p>This link is not available.</p>';

export function publicRoutes(d: PublicDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Both buckets must have a token. Over-limit requests are still served, just not recorded.
  const allowed = (ipKey: string, resourceKey: string) =>
    d.resourceLimiter.take(resourceKey) && d.limiter.take(ipKey);

  app.get('/p/:file', (c) => {
    const gif = () => c.body(new Uint8Array(TRANSPARENT_GIF), 200, NO_STORE_HEADERS);
    const m = /^([A-Za-z0-9_-]{21})\.gif$/.exec(c.req.param('file'));
    if (!m?.[1]) return gif();
    // Rate-limited requests still get the image (never break the recipient's rendering),
    // they just aren't recorded.
    if (!allowed(`p:${c.get('ipHash')}`, `p:${c.get('ipHash')}:${m[1]}`)) return gif();
    try {
      recordOpen(d.tracking, m[1], {
        ip: d.getIp(c),
        ua: c.req.header('user-agent'),
        sig: c.req.query('s'),
        now: d.now(),
      });
    } catch (err) {
      d.log(`pixel record failed: ${(err as Error).message}`);
    }
    return gif();
  });

  app.get('/l/:linkId', (c) => {
    const linkId = c.req.param('linkId');
    if (!ID_PATTERN.test(linkId)) return c.html(NOT_FOUND_HTML, 404);
    const limited = !allowed(`l:${c.get('ipHash')}`, `l:${c.get('ipHash')}:${linkId}`);
    let url: string | null;
    if (limited) {
      url = d.tracking.repo.getLinkWithMessage(linkId)?.link.original_url ?? null;
    } else {
      url = recordClick(d.tracking, linkId, {
        ip: d.getIp(c),
        ua: c.req.header('user-agent'),
        sig: c.req.query('s'),
        now: d.now(),
      }).url;
    }
    if (url === null) return c.html(NOT_FOUND_HTML, 404);
    // Defence in depth: only http(s) targets that were registered for this link id.
    if (!isHttpUrl(url)) return c.html(NOT_FOUND_HTML, 400);
    c.header('Cache-Control', 'no-store, max-age=0');
    c.header('Referrer-Policy', 'no-referrer');
    return c.redirect(url, 302);
  });

  return app;
}
