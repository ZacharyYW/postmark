import { describe, expect, it } from 'vitest';
import type { AccountInfo, EventsRes, MessageSummary, Reminder } from '@postmark/shared';
import { BASE, createMessage, makeCtx, pixel, UA } from './helpers';

const json = async <T>(r: Response) => (await r.json()) as T;

describe('auth', () => {
  it('registers and rejects duplicate email by default', async () => {
    const ctx = makeCtx();
    const r1 = await ctx.req('/v1/auth/register', { method: 'POST', json: { email: 'A@B.com' } });
    expect(r1.status).toBe(201);
    const body = await json<{ token: string; email: string }>(r1);
    expect(body.email).toBe('a@b.com');
    expect(body.token.length).toBeGreaterThan(30);
    const r2 = await ctx.req('/v1/auth/register', { method: 'POST', json: { email: 'a@b.com' } });
    expect(r2.status).toBe(409);
  });

  it('allows rotation only when DEV_ALLOW_TOKEN_ROTATION', async () => {
    const ctx = makeCtx({ DEV_ALLOW_TOKEN_ROTATION: 'true' });
    const t1 = await ctx.register('a@b.com');
    const t2 = await ctx.register('a@b.com');
    expect(t2).not.toBe(t1);
    expect((await ctx.req('/v1/me', { token: t1 })).status).toBe(401);
    expect((await ctx.req('/v1/me', { token: t2 })).status).toBe(200);
  });

  it('rejects missing/invalid tokens', async () => {
    const ctx = makeCtx();
    expect((await ctx.req('/v1/messages')).status).toBe(401);
    expect((await ctx.req('/v1/messages', { token: 'x'.repeat(40) })).status).toBe(401);
  });

  it('validates bodies with structured errors', async () => {
    const ctx = makeCtx();
    const r = await ctx.req('/v1/auth/register', { method: 'POST', json: { email: 'nope' } });
    expect(r.status).toBe(400);
    const b = await json<{ error: { code: string; issues: unknown[] } }>(r);
    expect(b.error.code).toBe('VALIDATION');
    const bad = await ctx.req('/v1/auth/register', {
      method: 'POST',
      body: '{',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(bad.status).toBe(400);
  });
});

describe('messages', () => {
  it('creates a message with pixel + tracked links, deduping URLs', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token, {
      links: ['https://a.com/1', 'https://b.com/2', 'https://a.com/1'],
    });
    expect(m.messageId).toHaveLength(21);
    expect(m.pixelUrl).toBe(`${BASE}/p/${m.pixelId}.gif`);
    expect(m.rewrittenLinks.map((l) => l.original)).toEqual(['https://a.com/1', 'https://b.com/2']);
    expect(m.rewrittenLinks[0]!.trackedUrl).toMatch(new RegExp(`^${BASE}/l/[\\w-]{21}$`));
  });

  it('rejects javascript: and mailto links', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const r = await ctx.req('/v1/messages', {
      method: 'POST',
      token,
      json: {
        senderAccount: 'me@x.com',
        subject: 's',
        recipients: ['a@b.com'],
        links: ['javascript:alert(1)'],
      },
    });
    expect(r.status).toBe(400);
  });

  it('is idempotent on clientRequestId until bound (Undo Send / double click)', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const a = await createMessage(ctx, token, {
      clientRequestId: 'me@work.com:c1',
      links: ['https://a.com'],
    });
    const b = await createMessage(ctx, token, {
      clientRequestId: 'me@work.com:c1',
      links: ['https://a.com', 'https://new.com'],
    });
    expect(b.messageId).toBe(a.messageId);
    expect(b.pixelId).toBe(a.pixelId);
    expect(b.rewrittenLinks.map((l) => l.original)).toEqual(['https://a.com', 'https://new.com']);
    await ctx.req(`/v1/messages/${a.messageId}`, {
      method: 'PATCH',
      token,
      json: { gmailThreadId: 't1', gmailMessageId: 'm1' },
    });
    const r = await ctx.req('/v1/messages', {
      method: 'POST',
      token,
      json: {
        senderAccount: 'me@work.com',
        subject: 's',
        recipients: ['a@b.com'],
        links: [],
        clientRequestId: 'me@work.com:c1',
      },
    });
    expect(r.status).toBe(409);
  });

  it('binds gmail ids and lists with filters', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const a = await createMessage(ctx, token, {
      senderAccount: 'Work@Corp.com',
      subject: 'Quarterly report',
    });
    ctx.advance(1000);
    const b = await createMessage(ctx, token, {
      senderAccount: 'me@gmail.com',
      subject: 'Dinner',
      recipients: ['pal@friends.org'],
    });
    await ctx.req(`/v1/messages/${a.messageId}`, {
      method: 'PATCH',
      token,
      json: { gmailThreadId: 'thrA' },
    });
    await ctx.req(`/v1/messages/${b.messageId}`, {
      method: 'PATCH',
      token,
      json: { gmailThreadId: 'thrB' },
    });

    const all = await json<{ messages: MessageSummary[] }>(
      await ctx.req('/v1/messages', { token }),
    );
    expect(all.messages.map((m) => m.id)).toEqual([b.messageId, a.messageId]);

    const work = await json<{ messages: MessageSummary[] }>(
      await ctx.req('/v1/messages?account=work@corp.com', { token }),
    );
    expect(work.messages.map((m) => m.senderAccount)).toEqual(['work@corp.com']);

    const multi = await json<{ messages: MessageSummary[] }>(
      await ctx.req('/v1/messages?accounts=work@corp.com,alias@corp.com', { token }),
    );
    expect(multi.messages.map((m) => m.id)).toEqual([a.messageId]);
    expect((await ctx.req('/v1/messages?accounts=bad', { token })).status).toBe(400);

    const byThread = await json<{ messages: MessageSummary[] }>(
      await ctx.req('/v1/messages?threadIds=thrB,zzz', { token }),
    );
    expect(byThread.messages.map((m) => m.id)).toEqual([b.messageId]);

    const search = await json<{ messages: MessageSummary[] }>(
      await ctx.req('/v1/messages?q=friends', { token }),
    );
    expect(search.messages.map((m) => m.id)).toEqual([b.messageId]);
    const searchPct = await json<{ messages: MessageSummary[] }>(
      await ctx.req('/v1/messages?q=%25', { token }),
    );
    expect(searchPct.messages).toHaveLength(0);
  });

  it('never exposes another user’s message', async () => {
    const ctx = makeCtx();
    const t1 = await ctx.register('one@x.com');
    const t2 = await ctx.register('two@x.com');
    const m = await createMessage(ctx, t1);
    expect((await ctx.req(`/v1/messages/${m.messageId}`, { token: t2 })).status).toBe(404);
    expect(
      (
        await ctx.req(`/v1/messages/${m.messageId}`, {
          method: 'PATCH',
          token: t2,
          json: { gmailThreadId: 'x' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await json<{ messages: unknown[] }>(await ctx.req('/v1/messages', { token: t2 }))).messages,
    ).toHaveLength(0);
  });
});

describe('pixel', () => {
  it('returns a 43-byte no-store GIF even for unknown ids', async () => {
    const ctx = makeCtx();
    for (const path of ['/p/doesnotexist0000000000.gif', '/p/garbage']) {
      const r = await ctx.req(path);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/gif');
      expect(r.headers.get('cache-control')).toContain('no-store');
      expect(r.headers.get('cache-control')).toContain('max-age=0');
      expect((await r.arrayBuffer()).byteLength).toBe(43);
    }
  });

  it('counts Gmail proxy opens, suppresses opens within 10s, dedupes within 30s', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token);
    await pixel(ctx, m.pixelId, UA.gmail); // t+0: sender grace
    ctx.advance(60_000);
    await pixel(ctx, m.pixelId, UA.gmail); // counted
    ctx.advance(5_000);
    await pixel(ctx, m.pixelId, UA.gmail); // dedupe
    ctx.advance(40_000);
    await pixel(ctx, m.pixelId, UA.gmail); // counted again
    const s = await json<MessageSummary>(await ctx.req(`/v1/messages/${m.messageId}`, { token }));
    expect(s.opens.total).toBe(2);
    expect(s.opens.unique).toBe(1);
    expect(s.status).toBe('opened');
    const ev = await json<{ events: { uaClass: string; isFirst: boolean }[] }>(
      await ctx.req(`/v1/messages/${m.messageId}/events`, { token }),
    );
    expect(ev.events.map((e) => e.uaClass)).toEqual(['sender', 'gmail_proxy', 'gmail_proxy']);
    expect(ev.events.map((e) => e.isFirst)).toEqual([false, true, false]);
  });

  it('treats MPP as auto-loaded and bots as excluded', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token);
    ctx.advance(30_000);
    await pixel(ctx, m.pixelId, UA.appleMail);
    await pixel(ctx, m.pixelId, UA.curl);
    const s = await json<MessageSummary>(await ctx.req(`/v1/messages/${m.messageId}`, { token }));
    expect(s.opens.total).toBe(0);
    expect(s.opens.autoLoaded).toBe(1);
    expect(s.status).toBe('auto_loaded');
    expect(s.lastEvent?.uaClass).toBe('apple_mpp');
  });

  it('classifies Apple egress IPs as MPP', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token);
    ctx.advance(3_600_000);
    ctx.ip.value = '17.58.1.2';
    await pixel(ctx, m.pixelId, UA.chrome);
    const s = await json<MessageSummary>(await ctx.req(`/v1/messages/${m.messageId}`, { token }));
    expect(s.opens.autoLoaded).toBe(1);
  });
});

describe('self-open suppression (per sender account)', () => {
  it('self-view beacon from the sending account reclassifies earlier proxy opens', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token, { senderAccount: 'a@work.com' });
    ctx.advance(60_000);
    await pixel(ctx, m.pixelId, UA.gmail); // sender opened Sent view; proxy fetch arrives first
    ctx.advance(3_000);
    const r = await ctx.req(`/v1/messages/${m.messageId}/self-view`, {
      method: 'POST',
      token,
      json: { account: 'A@work.com' },
    });
    expect(r.status).toBe(204);
    const s = await json<MessageSummary>(await ctx.req(`/v1/messages/${m.messageId}`, { token }));
    expect(s.opens.total).toBe(0);
  });

  it('beacon before the proxy fetch also suppresses it', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token, { senderAccount: 'a@work.com' });
    ctx.advance(60_000);
    await ctx.req(`/v1/messages/${m.messageId}/self-view`, {
      method: 'POST',
      token,
      json: { account: 'a@work.com' },
    });
    ctx.advance(2_000);
    await pixel(ctx, m.pixelId, UA.gmail);
    const s = await json<MessageSummary>(await ctx.req(`/v1/messages/${m.messageId}`, { token }));
    expect(s.opens.total).toBe(0);
  });

  it('an open seen by another of the user’s accounts (B) still counts', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token, {
      senderAccount: 'a@work.com',
      recipients: ['b@gmail.com'],
    });
    ctx.advance(60_000);
    // Account B's tab reports a self-view: must be ignored (B is a recipient, not the sender).
    await ctx.req(`/v1/messages/${m.messageId}/self-view`, {
      method: 'POST',
      token,
      json: { account: 'b@gmail.com' },
    });
    await pixel(ctx, m.pixelId, UA.gmail);
    const s = await json<MessageSummary>(await ctx.req(`/v1/messages/${m.messageId}`, { token }));
    expect(s.opens.total).toBe(1);
  });

  it('opens outside the self-view window still count and isFirst is promoted', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token, { senderAccount: 'a@work.com' });
    ctx.advance(60_000);
    await pixel(ctx, m.pixelId, UA.gmail); // will be reclassified
    ctx.advance(60_000);
    ctx.ip.value = '198.51.100.9';
    await pixel(ctx, m.pixelId, UA.gmail); // real recipient
    ctx.advance(-55_000);
    await ctx.req(`/v1/messages/${m.messageId}/self-view`, {
      method: 'POST',
      token,
      json: { account: 'a@work.com' },
    });
    const ev = await json<{ events: { uaClass: string; isFirst: boolean }[] }>(
      await ctx.req(`/v1/messages/${m.messageId}/events`, { token }),
    );
    expect(ev.events.map((e) => [e.uaClass, e.isFirst])).toEqual([
      ['sender', false],
      ['gmail_proxy', true],
    ]);
  });

  it('a valid ?s= signature marks direct fetches as sender', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token, { senderAccount: 'a@work.com' });
    const { signShort } = await import('../src/lib/crypto');
    const { senderSigValue } = await import('../src/tracking/record');
    const sig = signShort(ctx.tracking.signSecret, senderSigValue(m.pixelId, 'a@work.com'));
    ctx.advance(60_000);
    await pixel(ctx, m.pixelId, UA.chrome, `?s=${sig}`);
    ctx.ip.value = '198.51.100.10';
    await pixel(ctx, m.pixelId, UA.chrome, '?s=AAAAAAAAAAAAAAAA');
    const ev = await json<{ events: { uaClass: string }[] }>(
      await ctx.req(`/v1/messages/${m.messageId}/events`, { token }),
    );
    expect(ev.events.map((e) => e.uaClass)).toEqual(['sender', 'other']);
  });
});

describe('link redirect', () => {
  it('records clicks and redirects only to registered URLs', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token, { links: ['https://example.com/a?x=1'] });
    const link = m.rewrittenLinks[0]!;
    ctx.advance(60_000);
    const r = await ctx.req(`/l/${link.linkId}`, { headers: { 'User-Agent': UA.chrome } });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://example.com/a?x=1');
    const s = await json<MessageSummary>(await ctx.req(`/v1/messages/${m.messageId}`, { token }));
    expect(s.clicks.total).toBe(1);
    expect(s.links[0]!.clicks).toBe(1);
    expect(s.status).toBe('clicked');
  });

  it('404s unknown and malformed ids without reflecting input; no open redirect', async () => {
    const ctx = makeCtx();
    expect((await ctx.req('/l/AAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    const r = await ctx.req('/l/https%3A%2F%2Fevil.com');
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('evil');
    expect((await ctx.req('/l/x?url=https://evil.com')).status).toBe(404);
  });

  it('scanner clicks right after send are excluded', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token);
    ctx.advance(2_000);
    await ctx.req(`/l/${m.rewrittenLinks[0]!.linkId}`, { headers: { 'User-Agent': UA.chrome } });
    ctx.advance(60_000);
    await ctx.req(`/l/${m.rewrittenLinks[0]!.linkId}`, {
      headers: { 'User-Agent': UA.proofpoint },
    });
    const s = await json<MessageSummary>(await ctx.req(`/v1/messages/${m.messageId}`, { token }));
    expect(s.clicks.total).toBe(0);
  });
});

describe('accounts', () => {
  it('lists distinct sender accounts with counts and per-account settings', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    await createMessage(ctx, token, { senderAccount: 'a@work.com' });
    await createMessage(ctx, token, { senderAccount: 'a@work.com' });
    await createMessage(ctx, token, { senderAccount: 'b@gmail.com' });
    const r = await ctx.req('/v1/accounts/b%40gmail.com', {
      method: 'PATCH',
      token,
      json: { trackingDefault: false, notificationsEnabled: false },
    });
    expect(r.status).toBe(200);
    const res = await json<{ accounts: AccountInfo[] }>(await ctx.req('/v1/accounts', { token }));
    expect(res.accounts).toEqual([
      expect.objectContaining({ account: 'a@work.com', messageCount: 2, settings: {} }),
      expect.objectContaining({
        account: 'b@gmail.com',
        messageCount: 1,
        settings: { trackingDefault: false, notificationsEnabled: false },
      }),
    ]);
  });

  it('accepts settings for an account that has never sent, and null clears a key', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    await ctx.req('/v1/accounts/new@x.com', {
      method: 'PATCH',
      token,
      json: { trackingDefault: false, quietHours: { start: '22:00', end: '07:00' } },
    });
    let info = await json<AccountInfo>(
      await ctx.req('/v1/accounts/new@x.com', {
        method: 'PATCH',
        token,
        json: { trackingDefault: null },
      }),
    );
    expect(info).toMatchObject({
      account: 'new@x.com',
      messageCount: 0,
      settings: { quietHours: { start: '22:00', end: '07:00' } },
    });
    expect(info.settings.trackingDefault).toBeUndefined();
    info = await json<AccountInfo>(
      await ctx.req('/v1/accounts/new@x.com', {
        method: 'PATCH',
        token,
        json: { quietHours: null },
      }),
    );
    expect(info.settings).toEqual({});
  });

  it('rejects unknown settings keys', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const r = await ctx.req('/v1/accounts/a@x.com', { method: 'PATCH', token, json: { evil: 1 } });
    expect(r.status).toBe(400);
  });
});

describe('events polling', () => {
  it('bootstraps cursor, withholds unsettled events, filters by account', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const a = await createMessage(ctx, token, { senderAccount: 'a@work.com' });
    const b = await createMessage(ctx, token, { senderAccount: 'b@gmail.com' });
    ctx.advance(60_000);
    await pixel(ctx, a.pixelId, UA.gmail);
    const boot = await json<EventsRes>(await ctx.req('/v1/events', { token }));
    expect(boot.events).toHaveLength(0);
    expect(Number(boot.cursor)).toBeGreaterThan(0);

    await pixel(ctx, b.pixelId, UA.gmail);
    ctx.ip.value = '198.51.100.1';
    await pixel(ctx, a.pixelId, UA.gmail);
    // Not settled yet.
    let page = await json<EventsRes>(await ctx.req(`/v1/events?cursor=${boot.cursor}`, { token }));
    expect(page.events).toHaveLength(0);
    expect(page.cursor).toBe(boot.cursor);
    ctx.advance(25_000);
    page = await json<EventsRes>(await ctx.req(`/v1/events?cursor=${boot.cursor}`, { token }));
    expect(page.events.map((e) => e.senderAccount)).toEqual(['b@gmail.com', 'a@work.com']);
    expect(page.events[0]).toMatchObject({
      type: 'open',
      uaClass: 'gmail_proxy',
      isFirst: true,
      subject: 'Hello',
    });
    const onlyA = await json<EventsRes>(
      await ctx.req(`/v1/events?cursor=${boot.cursor}&account=a@work.com`, { token }),
    );
    expect(onlyA.events.map((e) => e.messageId)).toEqual([a.messageId]);
    const after = await json<EventsRes>(
      await ctx.req(`/v1/events?cursor=${page.cursor}`, { token }),
    );
    expect(after.events).toHaveLength(0);
  });

  it('accepts since=<iso>', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const a = await createMessage(ctx, token);
    ctx.advance(60_000);
    await pixel(ctx, a.pixelId, UA.gmail);
    ctx.advance(30_000);
    const r = await json<EventsRes>(
      await ctx.req(`/v1/events?since=${new Date(ctx.clock.now - 120_000).toISOString()}`, {
        token,
      }),
    );
    expect(r.events).toHaveLength(1);
  });
});

describe('reminders', () => {
  it('creates, lists, patches and deletes', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token, { senderAccount: 'a@work.com' });
    const remindAt = new Date(ctx.clock.now + 3 * 86_400_000).toISOString();
    const c = await ctx.req('/v1/reminders', {
      method: 'POST',
      token,
      json: { messageId: m.messageId, remindAt, condition: 'no_open' },
    });
    expect(c.status).toBe(201);
    const rem = await json<Reminder>(c);
    expect(rem).toMatchObject({
      messageId: m.messageId,
      condition: 'no_open',
      status: 'pending',
      senderAccount: 'a@work.com',
    });
    const list = await json<{ reminders: Reminder[] }>(
      await ctx.req('/v1/reminders?status=pending', { token }),
    );
    expect(list.reminders).toHaveLength(1);
    const p = await json<Reminder>(
      await ctx.req(`/v1/reminders/${rem.id}`, {
        method: 'PATCH',
        token,
        json: { status: 'fired' },
      }),
    );
    expect(p.status).toBe('fired');
    expect((await ctx.req(`/v1/reminders/${rem.id}`, { method: 'DELETE', token })).status).toBe(
      204,
    );
    expect((await ctx.req(`/v1/reminders/${rem.id}`, { method: 'DELETE', token })).status).toBe(
      404,
    );
  });

  it('rejects past or far-future reminders and foreign messages', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const other = await ctx.register('o@x.com');
    const m = await createMessage(ctx, token);
    const past = new Date(ctx.clock.now - 86_400_000).toISOString();
    expect(
      (
        await ctx.req('/v1/reminders', {
          method: 'POST',
          token,
          json: { messageId: m.messageId, remindAt: past, condition: 'always' },
        })
      ).status,
    ).toBe(400);
    const soon = new Date(ctx.clock.now + 86_400_000).toISOString();
    expect(
      (
        await ctx.req('/v1/reminders', {
          method: 'POST',
          token: other,
          json: { messageId: m.messageId, remindAt: soon, condition: 'always' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('DELETE /v1/me', () => {
  it('erases the user and all their data', async () => {
    const ctx = makeCtx();
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token);
    ctx.advance(60_000);
    await pixel(ctx, m.pixelId, UA.gmail);
    expect((await ctx.req('/v1/me', { method: 'DELETE', token })).status).toBe(204);
    expect((await ctx.req('/v1/me', { token })).status).toBe(401);
    expect(ctx.repo.getMessageByPixel(m.pixelId)).toBeUndefined();
    expect((await ctx.req(`/l/${m.rewrittenLinks[0]!.linkId}`)).status).toBe(404);
  });
});

describe('cross-cutting', () => {
  it('sets security headers', async () => {
    const ctx = makeCtx();
    const r = await ctx.req('/healthz');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('CORS allows only Gmail and extension origins on /v1', async () => {
    const ctx = makeCtx({ EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop' });
    const ok = await ctx.req('/v1/me', {
      method: 'OPTIONS',
      headers: {
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe(
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    );
    const gmail = await ctx.req('/v1/me', {
      method: 'OPTIONS',
      headers: { Origin: 'https://mail.google.com', 'Access-Control-Request-Method': 'GET' },
    });
    expect(gmail.headers.get('access-control-allow-origin')).toBe('https://mail.google.com');
    for (const origin of [
      'https://evil.com',
      'chrome-extension://pppppppppppppppppppppppppppppppp',
    ]) {
      const bad = await ctx.req('/v1/me', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
      });
      expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('rate limits authenticated routes per user and public routes per IP (pixel still served)', async () => {
    const ctx = makeCtx({}, false);
    const token = await ctx.register('u@x.com');
    const m = await createMessage(ctx, token);
    ctx.advance(60_000);
    let last = 0;
    for (let i = 0; i < 70; i++) last = (await pixel(ctx, m.pixelId, UA.gmail)).status;
    expect(last).toBe(200);
    let limited = false;
    for (let i = 0; i < 130 && !limited; i++) {
      limited = (await ctx.req('/v1/me', { token })).status === 429;
    }
    expect(limited).toBe(true);
  });

  it('JSON 404 for unknown API routes', async () => {
    const ctx = makeCtx();
    const r = await ctx.req('/nope');
    expect(r.status).toBe(404);
  });
});
