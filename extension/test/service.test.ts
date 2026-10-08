import { describe, expect, it } from 'vitest';
import type { TrackingEvent } from '@postmark/shared';
import { planNotifications, summarizeQueue } from '../src/background/notify';
import { reminderStillUnmet } from '../src/background/reminderLogic';
import { normalizeServerUrl } from '../src/background/service';
import { resolveSettings } from '@postmark/shared';
import { createHarness, flush, SERVER, signIn } from './harness';

const UA_GMAIL = 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)';

async function twoAccounts() {
  const h = createHarness();
  await signIn(h);
  const tabA = h.busFor(1);
  const tabB = h.busFor(2);
  await tabA.send('ACTIVE_ACCOUNT', { account: 'a@work.com' });
  await tabB.send('ACTIVE_ACCOUNT', { account: 'b@gmail.com' });
  const mk = async (
    bus: typeof tabA,
    sender: string,
    thread: string,
    to: string[] = ['x@y.com'],
  ) => {
    const r = await bus.send('PREPARE_TRACKING', {
      clientRequestId: `${sender}:${thread}`,
      senderAccount: sender,
      subject: `from ${sender}`,
      recipients: to,
      links: ['https://example.com'],
    });
    if (!r.ok) throw new Error(r.error.message);
    await bus.send('BIND_SENT', {
      messageId: r.data.messageId,
      gmailThreadId: thread,
      gmailMessageId: `${thread}-m`,
    });
    return r.data;
  };
  return { h, tabA, tabB, mk };
}

async function hitPixel(h: ReturnType<typeof createHarness>, url: string, ua = UA_GMAIL) {
  return h.server.app.request(url, { headers: { 'User-Agent': ua } });
}

describe('multi-account separation in Gmail surfaces', () => {
  it('GET_MARKS only returns messages sent by the tab’s account', async () => {
    const { tabA, tabB, mk } = await twoAccounts();
    await mk(tabA, 'a@work.com', 'tA');
    await mk(tabB, 'b@gmail.com', 'tB');
    const a = await tabA.send('GET_MARKS', { threadIds: ['tA', 'tB'] });
    const b = await tabB.send('GET_MARKS', { threadIds: ['tA', 'tB'] });
    expect(a.ok && Object.keys(a.data.marks)).toEqual(['tA']);
    expect(b.ok && Object.keys(b.data.marks)).toEqual(['tB']);
  });

  it('GET_THREAD_TRACKING never leaks another account’s message in a shared thread', async () => {
    const { tabA, tabB, mk } = await twoAccounts();
    // B is a recipient of A's mail and replies in the same thread.
    await mk(tabA, 'a@work.com', 'shared', ['b@gmail.com']);
    await mk(tabB, 'b@gmail.com', 'shared', ['a@work.com']);
    const a = await tabA.send('GET_THREAD_TRACKING', { threadId: 'shared' });
    expect(a.ok && a.data.messages.map((m) => m.senderAccount)).toEqual(['a@work.com']);
  });

  it('aliases join the tab scope', async () => {
    const { h, tabA, mk } = await twoAccounts();
    await mk(tabA, 'sales@work.com', 'tS'); // alias first used in this tab
    const a = await tabA.send('GET_MARKS', { threadIds: ['tS'] });
    expect(a.ok && Object.keys(a.data.marks)).toEqual(['tS']);
    expect((await h.service.tabScope(1))?.aliases).toEqual(['sales@work.com']);
  });

  it('requires the tab to have reported its account', async () => {
    const h = createHarness();
    await signIn(h);
    const r = await h.busFor(9).send('GET_MARKS', { threadIds: ['x'] });
    expect(r).toMatchObject({ ok: false, error: { code: 'NO_ACCOUNT' } });
  });

  it('SELF_VIEW from the sender tab suppresses; from another account’s tab it counts', async () => {
    const { h, tabA, tabB, mk } = await twoAccounts();
    const m = await mk(tabA, 'a@work.com', 'tA', ['b@gmail.com']);
    h.clock.now += 60_000;
    // B (a recipient, same Postmark user) opens it: beacon from tab B must be a no-op.
    await tabB.send('SELF_VIEW', { messageId: m.messageId });
    await hitPixel(h, m.pixelUrl);
    let s = await h.service.api.getMessage(m.messageId);
    expect(s.opens.total).toBe(1);
    // Later, A views their own sent message.
    h.clock.now += 120_000;
    await tabA.send('SELF_VIEW', { messageId: m.messageId });
    h.clock.now += 1_000;
    await hitPixel(h, m.pixelUrl);
    s = await h.service.api.getMessage(m.messageId);
    expect(s.opens.total).toBe(1);
  });
});

describe('polling, notifications and reminders', () => {
  it('poll notifies first opens once, names the account when >1 known, then broadcasts', async () => {
    const { h, tabA, mk } = await twoAccounts();
    const m = await mk(tabA, 'a@work.com', 'tA');
    h.clock.now += 60_000;
    await hitPixel(h, m.pixelUrl);
    h.clock.now += 1_000;
    await hitPixel(h, m.pixelUrl, 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36');
    h.clock.now += 30_000;
    await h.service.poll();
    const shown = chrome.notifications as unknown as {
      _shown: { id: string; opts: { title: string; message: string } }[];
    };
    expect(shown._shown).toHaveLength(1);
    expect(shown._shown[0]!.opts.title).toBe('Opened: from a@work.com');
    expect(shown._shown[0]!.opts.message).toContain('via a@work.com');
    const sent = (chrome.tabs as unknown as { _sent: { tabId: number }[] })._sent;
    expect(sent.map((s) => s.tabId)).toContain(1);
    expect(sent.map((s) => s.tabId)).not.toContain(2);
    await h.service.poll();
    expect(shown._shown).toHaveLength(1);
  });

  it('respects per-account notificationsEnabled=false', async () => {
    const { h, tabB, mk } = await twoAccounts();
    await h.busFor().send('UPDATE_ACCOUNT_SETTINGS', {
      account: 'b@gmail.com',
      settings: { notificationsEnabled: false },
    });
    const m = await mk(tabB, 'b@gmail.com', 'tB');
    h.clock.now += 60_000;
    await hitPixel(h, m.pixelUrl);
    h.clock.now += 30_000;
    await h.service.poll();
    expect((chrome.notifications as unknown as { _shown: unknown[] })._shown).toHaveLength(0);
  });

  it('notification click opens the thread under the right account', async () => {
    const { h, tabA, mk } = await twoAccounts();
    const m = await mk(tabA, 'a@work.com', 'tA');
    h.clock.now += 60_000;
    await hitPixel(h, m.pixelUrl);
    h.clock.now += 30_000;
    await h.service.poll();
    const id = (chrome.notifications as unknown as { _shown: { id: string }[] })._shown[0]!.id;
    await h.service.onNotificationClicked(id);
    expect((chrome.tabs as unknown as { _created: string[] })._created).toEqual([
      'https://mail.google.com/mail/?authuser=a%40work.com#all/tA',
    ]);
  });

  it('reminder fires only if the condition is still unmet', async () => {
    const { h, tabA, mk } = await twoAccounts();
    const m = await mk(tabA, 'a@work.com', 'tA');
    const remindAt = new Date(h.clock.now + 86_400_000).toISOString();
    const r1 = await tabA.send('CREATE_REMINDER', {
      messageId: m.messageId,
      remindAt,
      condition: 'no_open',
    });
    expect(r1.ok).toBe(true);
    const alarms = (chrome.alarms as unknown as { _alarms: Map<string, unknown> })._alarms;
    expect([...alarms.keys()].some((k) => k.startsWith('pm-rem:'))).toBe(true);
    // Recipient opens before the reminder is due → satisfied, no notification.
    h.clock.now += 60_000;
    await hitPixel(h, m.pixelUrl);
    await h.service.onReminderAlarm(r1.ok ? r1.data.id : '');
    expect((chrome.notifications as unknown as { _shown: unknown[] })._shown).toHaveLength(0);
    const m2 = await mk(tabA, 'a@work.com', 'tA2');
    const r2 = await tabA.send('CREATE_REMINDER', {
      messageId: m2.messageId,
      remindAt,
      condition: 'no_open',
    });
    await h.service.onReminderAlarm(r2.ok ? r2.data.id : '');
    const shown = (chrome.notifications as unknown as { _shown: { opts: { title: string } }[] })
      ._shown;
    expect(shown).toHaveLength(1);
    expect(shown[0]!.opts.title).toMatch(/^Follow up/);
    const pending = await h.service.api.listReminders({ status: 'pending' });
    expect(pending.reminders).toHaveLength(0);
  });

  it('logout clears auth and alarms; 401 during poll signs out', async () => {
    const h = createHarness();
    await signIn(h);
    await h.busFor(1).send('ACTIVE_ACCOUNT', { account: 'a@b.com' });
    expect(await chrome.alarms.get('pm-poll')).toBeDefined();
    await chrome.storage.local.set({ auth: { token: 'x'.repeat(43), email: 'me' } });
    await h.service.poll();
    expect((await chrome.storage.local.get('auth')).auth).toBeUndefined();
    expect(await chrome.alarms.get('pm-poll')).toBeUndefined();
  });

  it('polls every minute with a Gmail tab open, every 5 minutes otherwise', async () => {
    const h = createHarness();
    await signIn(h);
    expect((await chrome.alarms.get('pm-poll'))?.periodInMinutes).toBe(5);
    await h.busFor(4).send('ACTIVE_ACCOUNT', { account: 'a@b.com' });
    expect((await chrome.alarms.get('pm-poll'))?.periodInMinutes).toBe(1);
    await h.service.forgetTab(4);
    expect((await chrome.alarms.get('pm-poll'))?.periodInMinutes).toBe(5);
  });

  it('CONNECT_TOKEN signs in with an existing token; rejects bad ones', async () => {
    const h = createHarness();
    await chrome.storage.local.set({ serverUrl: SERVER });
    const reg = await h.server.app.request(`${SERVER}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'seed@x.com' }),
    });
    const { token } = (await reg.json()) as { token: string };
    const page = h.busFor();
    expect(await page.send('CONNECT_TOKEN', { token: 'bad token' })).toMatchObject({ ok: false });
    expect(await page.send('CONNECT_TOKEN', { token: 'y'.repeat(43) })).toMatchObject({
      ok: false,
      error: { code: 'NOT_AUTHENTICATED' },
    });
    expect((await chrome.storage.local.get('auth')).auth).toBeUndefined();
    const ok = await page.send('CONNECT_TOKEN', { token });
    expect(ok).toEqual({ ok: true, data: { email: 'seed@x.com' } });
    await flush();
  });
});

describe('pure helpers', () => {
  const ev = (o: Partial<TrackingEvent>): TrackingEvent => ({
    id: 1,
    messageId: 'm1',
    linkId: null,
    linkUrl: null,
    type: 'open',
    occurredAt: '2026-01-01T00:00:00Z',
    uaClass: 'gmail_proxy',
    isFirst: true,
    senderAccount: 'a@x.com',
    subject: 'S',
    recipients: ['r@x.com'],
    gmailThreadId: 't',
    ...o,
  });
  const ctx = {
    resolve: () => resolveSettings(),
    multiAccount: false,
    now: new Date(2026, 0, 1, 12),
  };

  it('ignores non-first opens and excluded classes', () => {
    const plan = planNotifications(
      [
        ev({ isFirst: false }),
        ev({ uaClass: 'apple_mpp' }),
        ev({ uaClass: 'bot' }),
        ev({ uaClass: 'sender' }),
      ],
      ctx,
    );
    expect(plan.show).toHaveLength(0);
  });

  it('batches clicks per message', () => {
    const plan = planNotifications(
      [
        ev({ type: 'click', id: 1, linkUrl: 'https://a.com/x' }),
        ev({ type: 'click', id: 2, linkUrl: 'https://b.com' }),
      ],
      ctx,
    );
    expect(plan.show).toHaveLength(1);
    expect(plan.show[0]!.title).toBe('2 link clicks');
  });

  it('omits "via" with a single account and never claims certainty', () => {
    const plan = planNotifications([ev({})], ctx);
    expect(plan.show[0]!.message).not.toContain('via');
    expect(plan.show[0]!.message).toContain('likely');
  });

  it('caps a burst and adds a summary', () => {
    const events = Array.from({ length: 9 }, (_, i) => ev({ id: i, messageId: `m${i}` }));
    const plan = planNotifications(events, ctx);
    expect(plan.show).toHaveLength(5);
    expect(plan.show[4]!.kind).toBe('summary');
    expect(plan.show[4]!.message).toBe('5 more tracking updates');
  });

  it('queues during quiet hours', () => {
    const plan = planNotifications([ev({})], {
      ...ctx,
      resolve: () => resolveSettings(null, { quietHours: { start: '09:00', end: '17:00' } }),
    });
    expect(plan.show).toHaveLength(0);
    expect(plan.queued).toHaveLength(1);
    expect(
      summarizeQueue([{ kind: 'open' }, { kind: 'open' }, { kind: 'click' }], new Date())!.message,
    ).toBe('2 opens, 1 click');
  });

  it('reminder conditions', () => {
    const base = { opens: { total: 0 }, clicks: { total: 0 }, repliedAt: null } as never;
    expect(reminderStillUnmet('no_open', base)).toBe(true);
    expect(
      reminderStillUnmet('no_open', { ...(base as object), opens: { total: 1 } } as never),
    ).toBe(false);
    expect(
      reminderStillUnmet('no_reply', {
        ...(base as object),
        repliedAt: '2026-01-01T00:00:00Z',
      } as never),
    ).toBe(false);
    expect(reminderStillUnmet('always', base)).toBe(true);
  });

  it('server URL normalisation', () => {
    expect(normalizeServerUrl('https://pm.example.com/some/path')).toBe('https://pm.example.com');
    expect(normalizeServerUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(() => normalizeServerUrl('http://pm.example.com')).toThrow();
    expect(() => normalizeServerUrl('ftp://x')).toThrow();
    expect(() => normalizeServerUrl('nope')).toThrow();
  });
});

describe('quiet hours per account', () => {
  it('holds notifications for an account in its own quiet hours and releases them later', async () => {
    const { h, tabA, mk } = await twoAccounts();
    const hour = new Date().getHours();
    const start = `${String(hour).padStart(2, '0')}:00`;
    const end = `${String((hour + 1) % 24).padStart(2, '0')}:00`;
    await h.busFor().send('UPDATE_ACCOUNT_SETTINGS', {
      account: 'a@work.com',
      settings: { quietHours: { start, end } },
    });
    const m = await mk(tabA, 'a@work.com', 'tQ');
    h.clock.now += 60_000;
    await hitPixel(h, m.pixelUrl);
    h.clock.now += 30_000;
    await h.service.poll();
    const shown = (chrome.notifications as unknown as { _shown: { opts: { title: string } }[] })
      ._shown;
    expect(shown).toHaveLength(0);
    const q = (await chrome.storage.local.get('quietQueue')).quietQueue as { account: string }[];
    expect(q).toEqual([expect.objectContaining({ account: 'a@work.com' })]);
    // Quiet hours over for that account → the next poll releases a summary.
    await h
      .busFor()
      .send('UPDATE_ACCOUNT_SETTINGS', { account: 'a@work.com', settings: { quietHours: null } });
    await h.service.poll();
    expect(shown.map((n) => n.opts.title)).toEqual(['While notifications were paused']);
    expect((await chrome.storage.local.get('quietQueue')).quietQueue).toEqual([]);
  });
});
