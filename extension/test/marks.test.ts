import { describe, expect, it } from 'vitest';
import { marksFor, pickLatest } from '../src/gmail/marks';
import { startListMarks } from '../src/gmail/listMarks';
import type { MarkIcon, ThreadRowHandle } from '../src/gmail/adapter';
import type { PushMap } from '@postmark/shared';
import { createHarness, flush, signIn } from './harness';
import { opened, summary } from './fixtures';

const icon = (n: string) => `icon:${n}`;

describe('marksFor', () => {
  it('grey ✓✓ for sent, not opened', () => {
    expect(marksFor([summary()], icon)).toEqual({
      status: { iconUrl: 'icon:sent', tooltip: 'Postmark: sent, not opened yet' },
      clicks: null,
    });
  });
  it('green ✓✓ with count and relative + absolute last-open time', () => {
    const m = marksFor([opened()], icon);
    expect(m.status!.iconUrl).toBe('icon:opened');
    expect(m.status!.tooltip).toMatch(/likely opened 3 times · last 10 min ago — /);
  });
  it('amber for possibly auto-loaded only', () => {
    const m = marksFor(
      [
        summary({
          opens: { total: 0, unique: 0, autoLoaded: 1, first: null, last: null },
          status: 'auto_loaded',
        }),
      ],
      icon,
    );
    expect(m.status!.iconUrl).toBe('icon:auto');
  });
  it('adds a link icon with click count', () => {
    const m = marksFor(
      [summary({ clicks: { total: 2, last: new Date().toISOString() }, status: 'clicked' })],
      icon,
    );
    expect(m.clicks!.tooltip).toMatch(/2 link clicks/);
  });
  it('uses the latest message in a thread', () => {
    const older = summary({ sentAt: '2026-01-01T00:00:00Z' });
    const newer = summary({ sentAt: '2026-02-01T00:00:00Z' });
    expect(pickLatest([older, newer])!.id).toBe(newer.id);
    expect(marksFor([], icon)).toEqual({ status: null, clicks: null });
  });
});

class FakeRow implements ThreadRowHandle {
  marks: { status: MarkIcon | null; clicks: MarkIcon | null } | null = null;
  setCount = 0;
  constructor(public threadId: string) {}
  getThreadId() {
    return Promise.resolve(this.threadId);
  }
  setMarks(m: { status: MarkIcon | null; clicks: MarkIcon | null }) {
    this.marks = m;
    this.setCount++;
  }
  getVisibleMessageCount() {
    return 1;
  }
  getContactEmails() {
    return [];
  }
  onDestroy() {}
}

describe('Sent-list marks controller (real SW + server)', () => {
  it('marks only this account’s threads and updates in place on DATA_UPDATED', async () => {
    const h = createHarness();
    await signIn(h);
    const tabA = h.busFor(1);
    const tabB = h.busFor(2);
    await tabA.send('ACTIVE_ACCOUNT', { account: 'a@work.com' });
    await tabB.send('ACTIVE_ACCOUNT', { account: 'b@gmail.com' });
    const mk = async (bus: typeof tabA, sender: string, thread: string) => {
      const r = await bus.send('PREPARE_TRACKING', {
        clientRequestId: thread,
        senderAccount: sender,
        subject: 's',
        recipients: ['x@y.com'],
        links: [],
      });
      if (!r.ok) throw new Error(r.error.message);
      await bus.send('BIND_SENT', {
        messageId: r.data.messageId,
        gmailThreadId: thread,
        gmailMessageId: `${thread}m`,
      });
      return r.data;
    };
    const a = await mk(tabA, 'a@work.com', 'TA');
    await mk(tabB, 'b@gmail.com', 'TB');

    const rowHandlers: ((r: ThreadRowHandle) => void)[] = [];
    const updates: ((p: PushMap['DATA_UPDATED']) => void)[] = [];
    const ctl = startListMarks({
      adapter: { onThreadRow: (fn) => rowHandlers.push(fn) },
      bus: tabA,
      iconUrl: icon,
      onUpdate: (fn) => {
        updates.push(fn);
        return () => {};
      },
      batchDelayMs: 1,
    });
    const rowA = new FakeRow('TA');
    const rowB = new FakeRow('TB');
    const rowX = new FakeRow('untracked');
    rowHandlers.forEach((fn) => [rowA, rowB, rowX].forEach((r) => fn(r)));
    await flush();
    await ctl.flush();
    await new Promise((r) => setTimeout(r, 10));

    expect(rowA.marks?.status?.iconUrl).toBe('icon:sent');
    expect(rowB.marks).toBeNull(); // B's message must not show in A's tab
    expect(rowX.marks).toBeNull();

    h.clock.now += 60_000;
    await h.server.app.request(a.pixelUrl, { headers: { 'User-Agent': 'GoogleImageProxy' } });
    updates.forEach((fn) => fn({ messageIds: [a.messageId], threadIds: ['TA', 'TB'] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(rowA.marks?.status?.iconUrl).toBe('icon:opened');
    expect(rowB.marks).toBeNull();
  });
});

describe('lastEventLabel honesty', () => {
  it('labels MPP fetches as possibly auto-loaded, not opened', async () => {
    const { lastEventLabel } = await import('../src/ui/format');
    const m = summary({
      lastEvent: { type: 'open', occurredAt: new Date().toISOString(), uaClass: 'apple_mpp' },
    });
    expect(lastEventLabel(m).text).toMatch(/^Possibly auto-loaded/);
  });
});

describe('list marks negative cache', () => {
  it('does not re-query untracked threads on every re-render, but a push bypasses the cache', async () => {
    const { fakeBus } = await import('./fakeBus');
    const bus = fakeBus({ GET_MARKS: () => ({ marks: {} }) });
    const handlers: ((r: ThreadRowHandle) => void)[] = [];
    const updates: ((p: PushMap['DATA_UPDATED']) => void)[] = [];
    let t = 1_000;
    startListMarks({
      adapter: { onThreadRow: (fn) => handlers.push(fn) },
      bus: bus.client,
      iconUrl: icon,
      onUpdate: (fn) => {
        updates.push(fn);
        return () => {};
      },
      batchDelayMs: 1,
      now: () => t,
    });
    const show = () => handlers.forEach((fn) => fn(new FakeRow('X')));
    show();
    await new Promise((r) => setTimeout(r, 10));
    show(); // Gmail re-renders the Sent list
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.calls.filter((c) => c.type === 'GET_MARKS')).toHaveLength(1);
    t += 61_000;
    show();
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.calls.filter((c) => c.type === 'GET_MARKS')).toHaveLength(2);
    updates.forEach((fn) => fn({ messageIds: [], threadIds: ['X'] }));
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.calls.filter((c) => c.type === 'GET_MARKS')).toHaveLength(3);
  });
});
