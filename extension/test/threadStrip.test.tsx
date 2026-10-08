import { describe, expect, it } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/preact';
import type { PushMap } from '@postmark/shared';
import { matchMessage, startThreadStrips } from '../src/gmail/threadStrip';
import type { MessageViewHandle } from '../src/gmail/adapter';
import { fakeBus } from './fakeBus';
import { opened, summary } from './fixtures';

class FakeMessageView implements MessageViewHandle {
  host = document.createElement('div');
  body = document.createElement('div');
  destroyCbs: (() => void)[] = [];
  constructor(
    public sender: string,
    public threadId = 'T1',
    public messageId: string | null = 'G1',
    public later: string[] = [],
  ) {
    this.host.appendChild(this.body);
    document.body.appendChild(this.host);
  }
  getMessageId() {
    return Promise.resolve(this.messageId);
  }
  getThreadId() {
    return Promise.resolve(this.threadId);
  }
  getSenderEmail() {
    return this.sender;
  }
  getLaterSenders() {
    return this.later;
  }
  mountAboveBody(el: HTMLElement) {
    this.host.insertBefore(el, this.body);
    return true;
  }
  isLoaded() {
    return true;
  }
  onLoad() {}
  onDestroy(cb: () => void) {
    this.destroyCbs.push(cb);
  }
}

function setup(
  messages = [
    opened({
      id: 'm1',
      gmailThreadId: 'T1',
      gmailMessageId: 'G1',
      links: [
        {
          id: 'l1',
          originalUrl: 'https://example.com/doc',
          position: 0,
          clicks: 2,
          lastClick: null,
        },
      ],
    }),
  ],
) {
  const handlers: ((m: MessageViewHandle) => void)[] = [];
  const updates: ((p: PushMap['DATA_UPDATED']) => void)[] = [];
  const store = { v: false };
  const bus = fakeBus({
    GET_THREAD_TRACKING: () => ({ messages }),
    SELF_VIEW: () => ({ ok: true as const }),
    REPORT_REPLY: () => ({ ok: true as const }),
    CREATE_REMINDER: (p) => ({
      id: 'r1',
      messageId: p.messageId,
      remindAt: p.remindAt,
      condition: p.condition,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      subject: 's',
      recipients: [],
      senderAccount: 'a@work.com',
      gmailThreadId: 'T1',
    }),
  });
  startThreadStrips({
    adapter: { onMessageView: (fn) => handlers.push(fn) },
    bus: bus.client,
    scope: () => ['a@work.com', 'sales@work.com'],
    onUpdate: (fn) => {
      updates.push(fn);
      return () => {};
    },
    storage: { get: async () => store.v, set: async (v) => void (store.v = v) },
  });
  const show = (mv: FakeMessageView) => handlers.forEach((fn) => fn(mv));
  const shadowOf = (mv: FakeMessageView) =>
    mv.host.querySelector('postmark-ui')?.shadowRoot ?? null;
  return { bus, show, shadowOf, store, updates };
}

describe('thread tracking strip', () => {
  it('renders opens, per-link clicks and sends one self-view beacon for the sender’s own message', async () => {
    const { bus, show, shadowOf } = setup();
    const mv = new FakeMessageView('A@Work.com');
    show(mv);
    await waitFor(() => expect(shadowOf(mv)?.querySelector('section')).toBeTruthy());
    const root = shadowOf(mv)!;
    const section = within(root.querySelector('section') as HTMLElement);
    expect(section.getByText('Opened 3×')).toBeTruthy();
    expect(section.getByText('example.com')).toBeTruthy();
    expect(section.getByText('2 clicks')).toBeTruthy();
    expect(section.getByRole('button', { name: /Tracking/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(bus.calls.filter((c) => c.type === 'SELF_VIEW')).toHaveLength(1);
    expect(root.querySelector('style')!.textContent).toContain('prefers-color-scheme: dark');
  });

  it('does not render for messages from other people or other accounts', async () => {
    const { bus, show, shadowOf } = setup();
    const other = new FakeMessageView('b@gmail.com');
    show(other);
    await new Promise((r) => setTimeout(r, 20));
    expect(shadowOf(other)).toBeNull();
    expect(bus.calls.some((c) => c.type === 'SELF_VIEW')).toBe(false);
  });

  it('never shows another account’s tracking data even if the SW returned it', async () => {
    const { show, shadowOf } = setup([
      opened({ id: 'm9', senderAccount: 'b@gmail.com', gmailThreadId: 'T1', gmailMessageId: 'G1' }),
    ]);
    const mv = new FakeMessageView('a@work.com');
    show(mv);
    await new Promise((r) => setTimeout(r, 20));
    expect(shadowOf(mv)).toBeNull();
  });

  it('collapses and remembers the state', async () => {
    const { show, shadowOf, store } = setup();
    const mv = new FakeMessageView('a@work.com');
    show(mv);
    await waitFor(() => expect(shadowOf(mv)?.querySelector('section')).toBeTruthy());
    const toggle = within(shadowOf(mv)!.querySelector('section') as HTMLElement).getByRole(
      'button',
      { name: /Tracking/ },
    );
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    expect(store.v).toBe(true);
  });

  it('remind-me popover creates a reminder (3 days, if not opened)', async () => {
    const { bus, show, shadowOf } = setup();
    const mv = new FakeMessageView('a@work.com');
    show(mv);
    await waitFor(() => expect(shadowOf(mv)?.querySelector('section')).toBeTruthy());
    const section = within(shadowOf(mv)!.querySelector('section') as HTMLElement);
    fireEvent.click(section.getByRole('button', { name: 'Remind me' }));
    const dialog = within(section.getByRole('dialog', { name: /Remind me/ }));
    fireEvent.click(dialog.getByRole('button', { name: '3 days' }));
    fireEvent.click(dialog.getByLabelText(/Not opened/));
    fireEvent.click(dialog.getByRole('button', { name: 'Set reminder' }));
    await waitFor(() => expect(section.getByRole('status').textContent).toMatch(/Reminder set/));
    const call = bus.calls.find((c) => c.type === 'CREATE_REMINDER')!.payload as {
      condition: string;
      remindAt: string;
    };
    expect(call.condition).toBe('no_open');
    const days = (Date.parse(call.remindAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
  });

  it('reports a detected reply (later message from someone else)', async () => {
    const { bus, show } = setup();
    show(new FakeMessageView('a@work.com', 'T1', 'G1', ['a@work.com', 'you@example.com']));
    await waitFor(() => expect(bus.calls.some((c) => c.type === 'REPORT_REPLY')).toBe(true));
  });

  it('does not treat the user’s own follow-up as a reply', async () => {
    const { bus, show } = setup();
    show(new FakeMessageView('a@work.com', 'T1', 'G1', ['sales@work.com']));
    await new Promise((r) => setTimeout(r, 20));
    expect(bus.calls.some((c) => c.type === 'REPORT_REPLY')).toBe(false);
  });

  it('shows the "possibly auto-loaded" note', async () => {
    const { show, shadowOf } = setup([
      summary({
        id: 'm1',
        gmailThreadId: 'T1',
        gmailMessageId: 'G1',
        status: 'auto_loaded',
        opens: { total: 0, unique: 0, autoLoaded: 2, first: null, last: null },
      }),
    ]);
    const mv = new FakeMessageView('a@work.com');
    show(mv);
    await waitFor(() => expect(shadowOf(mv)?.textContent).toMatch(/Possibly auto-loaded 2 times/));
  });
});

describe('matchMessage', () => {
  it('matches by gmail message id, else a single unbound candidate', () => {
    const a = summary({ gmailMessageId: 'G1' });
    const b = summary({ gmailMessageId: null });
    expect(matchMessage([a, b], 'G1', new Set())).toBe(a);
    expect(matchMessage([a, b], 'G2', new Set())).toBe(b);
    expect(matchMessage([a, b, summary({ gmailMessageId: null })], 'G2', new Set())).toBeNull();
  });
});
