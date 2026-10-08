import { Hono } from 'hono';
import {
  BindMessageReq,
  CreateMessageReq,
  CreateReminderReq,
  EventsQuery,
  ListMessagesQuery,
  PatchAccountReq,
  PatchReminderReq,
  RegisterReq,
  RemindersQuery,
  SelfViewReq,
  TIMING,
  normalizeAccount,
  type AccountSettings,
  type CreateMessageRes,
  type MeRes,
  type RegisterRes,
} from '@postmark/shared';
import type { Repo, MessageRow } from '../db/repo';
import { newId, randomToken, sha256Hex } from '../lib/crypto';
import { ApiHttpError, jsonBody, notFound, parseOr400, type AppEnv } from '../http';
import { requireAuth } from '../middleware/auth';
import type { Limiters } from '../middleware/rateLimit';
import { recordSelfView, type TrackingContext } from '../tracking/record';

export interface ApiDeps {
  repo: Repo;
  limiters: Limiters;
  tracking: TrackingContext;
  publicBaseUrl: string;
  allowTokenRotation: boolean;
  now: () => number;
}

export function apiRoutes(d: ApiDeps): Hono<AppEnv> {
  const { repo } = d;
  const api = new Hono<AppEnv>();

  // ---------- auth (public, strictly rate-limited) ----------
  api.post('/auth/register', async (c) => {
    const ipHash = c.get('ipHash');
    if (!d.limiters.registerByIp.take(`r:${ipHash}`)) {
      throw new ApiHttpError(429, 'RATE_LIMITED', 'Too many registrations');
    }
    const { email } = parseOr400(RegisterReq, await jsonBody(c));
    const token = randomToken(32);
    const tokenHash = sha256Hex(token);
    const existing = repo.findUserByEmail(email);
    if (existing) {
      // TODO(prod): replace with Google OAuth via chrome.identity; see docs/DECISIONS.md D-006.
      if (!d.allowTokenRotation) {
        throw new ApiHttpError(409, 'EMAIL_TAKEN', 'This email is already registered');
      }
      repo.updateUserToken(existing.id, tokenHash);
      const res: RegisterRes = { token, userId: existing.id, email };
      return c.json(res, 200);
    }
    const userId = newId();
    repo.createUser({ id: userId, email, token_hash: tokenHash, created_at: d.now() });
    const res: RegisterRes = { token, userId, email };
    return c.json(res, 201);
  });

  // Everything below requires a bearer token.
  api.use('*', async (c, next) => {
    if (c.req.path.endsWith('/auth/register')) return next();
    return requireAuth(repo, d.limiters.apiByUser)(c, next);
  });

  // ---------- me ----------
  api.get('/me', (c) => {
    const u = c.get('user');
    const res: MeRes = {
      userId: u.id,
      email: u.email,
      createdAt: new Date(u.created_at).toISOString(),
    };
    return c.json(res);
  });

  api.delete('/me', (c) => {
    repo.deleteUser(c.get('user').id);
    return c.body(null, 204);
  });

  // ---------- messages ----------
  const buildCreateRes = (m: MessageRow): CreateMessageRes => ({
    messageId: m.id,
    pixelId: m.pixel_id,
    pixelUrl: `${d.publicBaseUrl}/p/${m.pixel_id}.gif`,
    rewrittenLinks: repo.linksForMessage(m.id).map((l) => ({
      original: l.original_url,
      trackedUrl: `${d.publicBaseUrl}/l/${l.id}`,
      linkId: l.id,
    })),
  });

  api.post('/messages', async (c) => {
    const user = c.get('user');
    const body = parseOr400(CreateMessageReq, await jsonBody(c));
    const uniqueLinks = [...new Set(body.links)];
    const now = d.now();

    const result = repo.tx(() => {
      if (body.clientRequestId) {
        const existing = repo.findMessageByClientRequest(user.id, body.clientRequestId);
        if (existing) {
          if (existing.gmail_message_id !== null) {
            throw new ApiHttpError(
              409,
              'ALREADY_SENT',
              'This compose was already sent and bound; start a new compose',
            );
          }
          if (existing.sender_account !== body.senderAccount) {
            throw new ApiHttpError(
              409,
              'ACCOUNT_MISMATCH',
              'clientRequestId reused across accounts',
            );
          }
          // Idempotent replay (Undo Send / double click): register any new URLs.
          const known = new Set(repo.linksForMessage(existing.id).map((l) => l.original_url));
          let pos = known.size;
          for (const url of uniqueLinks) {
            if (!known.has(url)) {
              repo.insertLink({
                id: newId(),
                message_id: existing.id,
                original_url: url,
                position: pos++,
              });
            }
          }
          return { message: existing, created: false };
        }
      }
      const message: MessageRow = {
        id: newId(),
        user_id: user.id,
        sender_account: body.senderAccount,
        gmail_thread_id: null,
        gmail_message_id: null,
        subject: body.subject,
        recipients_json: JSON.stringify(body.recipients),
        sent_at: now,
        tracking_enabled: 1,
        pixel_id: newId(),
        client_request_id: body.clientRequestId ?? null,
        replied_at: null,
        created_at: now,
      };
      repo.insertMessage(message);
      uniqueLinks.forEach((url, position) =>
        repo.insertLink({ id: newId(), message_id: message.id, original_url: url, position }),
      );
      return { message, created: true };
    });

    return c.json(buildCreateRes(result.message), result.created ? 201 : 200);
  });

  api.patch('/messages/:id', async (c) => {
    const user = c.get('user');
    const body = parseOr400(BindMessageReq, await jsonBody(c));
    const ok = repo.bindMessage(user.id, c.req.param('id'), {
      ...(body.gmailThreadId !== undefined && { gmailThreadId: body.gmailThreadId }),
      ...(body.gmailMessageId !== undefined && { gmailMessageId: body.gmailMessageId }),
      ...(body.repliedAt !== undefined && { repliedAt: Date.parse(body.repliedAt) }),
    });
    if (!ok) throw notFound('Message');
    const row = repo.getMessage(user.id, c.req.param('id'));
    if (!row) throw notFound('Message');
    return c.json(repo.summarize([row])[0]);
  });

  api.get('/messages', (c) => {
    const user = c.get('user');
    const q = parseOr400(ListMessagesQuery, c.req.query());
    const rows = repo.listMessageRows(user.id, {
      limit: q.limit,
      ...(q.account !== undefined && { account: q.account }),
      ...(q.accounts !== undefined && { accounts: q.accounts }),
      ...(q.since !== undefined && { since: Date.parse(q.since) }),
      ...(q.threadIds !== undefined && { threadIds: q.threadIds }),
      ...(q.q !== undefined && q.q.trim() !== '' && { q: q.q.trim() }),
    });
    return c.json({ messages: repo.summarize(rows) });
  });

  api.get('/messages/:id', (c) => {
    const row = repo.getMessage(c.get('user').id, c.req.param('id'));
    if (!row) throw notFound('Message');
    return c.json(repo.summarize([row])[0]);
  });

  // Owner-only: the pixel URL (used by scripts/simulate-open.ts and for debugging).
  api.get('/messages/:id/pixel', (c) => {
    const row = repo.getMessage(c.get('user').id, c.req.param('id'));
    if (!row) throw notFound('Message');
    return c.json({ pixelUrl: `${d.publicBaseUrl}/p/${row.pixel_id}.gif` });
  });

  api.get('/messages/:id/events', (c) => {
    const user = c.get('user');
    const row = repo.getMessage(user.id, c.req.param('id'));
    if (!row) throw notFound('Message');
    return c.json({ events: repo.eventsForMessage(user.id, row.id) });
  });

  api.post('/messages/:id/self-view', async (c) => {
    const user = c.get('user');
    const { account } = parseOr400(SelfViewReq, await jsonBody(c));
    const row = repo.getMessage(user.id, c.req.param('id'));
    if (!row) throw notFound('Message');
    recordSelfView(d.tracking, row, account, d.now());
    return c.body(null, 204);
  });

  // ---------- accounts ----------
  api.get('/accounts', (c) => c.json({ accounts: repo.accounts(c.get('user').id) }));

  api.patch('/accounts/:account', async (c) => {
    const user = c.get('user');
    const account = normalizeAccount(decodeURIComponent(c.req.param('account')));
    if (!account) throw new ApiHttpError(400, 'VALIDATION', 'Invalid account');
    const patch = parseOr400(PatchAccountReq, await jsonBody(c));
    const settings = repo.getUserSettings(user.id);
    const accounts = { ...(settings.accounts ?? {}) };
    if (!(account in accounts) && Object.keys(accounts).length >= 100) {
      throw new ApiHttpError(400, 'TOO_MANY_ACCOUNTS', 'Too many accounts with custom settings');
    }
    const current: AccountSettings = { ...(accounts[account] ?? {}) };
    for (const key of ['trackingDefault', 'notificationsEnabled', 'quietHours'] as const) {
      if (!(key in patch)) continue;
      const v = patch[key];
      if (v === null) delete current[key];
      else if (v !== undefined) (current as Record<string, unknown>)[key] = v;
    }
    accounts[account] = current;
    repo.setUserSettings(user.id, { ...settings, accounts });
    const info = repo.accounts(user.id).find((a) => a.account === account);
    return c.json(info);
  });

  // ---------- events (notification polling) ----------
  api.get('/events', (c) => {
    const user = c.get('user');
    const q = parseOr400(EventsQuery, c.req.query());
    if (q.cursor === undefined && q.since === undefined) {
      // Bootstrap: hand back the current high-water mark so a new client doesn't replay history.
      return c.json({ events: [], cursor: String(repo.maxEventIdForUser(user.id)) });
    }
    const cursor = q.cursor !== undefined ? Number(q.cursor) : undefined;
    const raw = repo.eventsAfter(user.id, {
      limit: q.limit,
      ...(cursor !== undefined && { cursor }),
      ...(q.since !== undefined && cursor === undefined && { since: Date.parse(q.since) }),
      ...(q.account !== undefined && { account: q.account }),
    });
    // Only hand out settled events, and stop at the first unsettled one so the cursor stays
    // contiguous (self-view reclassification may still change younger events).
    const settledBefore = d.now() - TIMING.EVENT_SETTLE_MS;
    const events = [];
    for (const e of raw) {
      if (Date.parse(e.occurredAt) > settledBefore) break;
      events.push(e);
    }
    const last = events[events.length - 1];
    return c.json({ events, cursor: String(last ? last.id : (cursor ?? 0)) });
  });

  // ---------- reminders ----------
  api.post('/reminders', async (c) => {
    const user = c.get('user');
    const body = parseOr400(CreateReminderReq, await jsonBody(c));
    const msg = repo.getMessage(user.id, body.messageId);
    if (!msg) throw notFound('Message');
    const remindAt = Date.parse(body.remindAt);
    const now = d.now();
    if (remindAt < now - 60_000 || remindAt > now + 366 * 86_400_000) {
      throw new ApiHttpError(400, 'VALIDATION', 'remindAt must be in the future (≤ 1 year)');
    }
    const id = newId();
    repo.insertReminder({
      id,
      message_id: msg.id,
      remind_at: remindAt,
      condition: body.condition,
      status: 'pending',
      created_at: now,
    });
    return c.json(repo.listReminders(user.id, { id })[0], 201);
  });

  api.get('/reminders', (c) => {
    const q = parseOr400(RemindersQuery, c.req.query());
    return c.json({
      reminders: repo.listReminders(c.get('user').id, {
        ...(q.status !== undefined && { status: q.status }),
        ...(q.account !== undefined && { account: q.account }),
      }),
    });
  });

  api.patch('/reminders/:id', async (c) => {
    const user = c.get('user');
    const { status } = parseOr400(PatchReminderReq, await jsonBody(c));
    if (!repo.updateReminderStatus(user.id, c.req.param('id'), status)) throw notFound('Reminder');
    return c.json(repo.listReminders(user.id, { id: c.req.param('id') })[0]);
  });

  api.delete('/reminders/:id', (c) => {
    if (!repo.deleteReminder(c.get('user').id, c.req.param('id'))) throw notFound('Reminder');
    return c.body(null, 204);
  });

  return api;
}
