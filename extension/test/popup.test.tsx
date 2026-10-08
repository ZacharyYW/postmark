import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import type { BusClient } from '../src/bus/client';
import { BusContext, PrefsContext } from '../src/ui/busContext';
import { ALL, Popup } from '../src/ui/popup/Popup';
import type { TrackingEvent } from '@postmark/shared';
import { fakeBus, memoryPrefs } from './fakeBus';
import { opened, summary } from './fixtures';

const ACCOUNTS = [
  { account: 'a@work.com', messageCount: 2, lastSentAt: null, settings: {} },
  { account: 'b@gmail.com', messageCount: 1, lastSentAt: null, settings: {} },
];

function mount(bus: BusClient, prefs = memoryPrefs(), onOpenOptions = () => {}) {
  return render(
    <BusContext.Provider value={bus}>
      <PrefsContext.Provider value={prefs}>
        <Popup onOpenOptions={onOpenOptions} />
      </PrefsContext.Provider>
    </BusContext.Provider>,
  );
}

const loggedIn = {
  loggedIn: true,
  email: 'me@x.com',
  serverUrl: 'http://localhost:8787',
  trackingOrigins: [],
};

describe('popup states', () => {
  it('logged-out', async () => {
    let opened = false;
    const { client } = fakeBus({
      GET_AUTH_STATE: () => ({
        loggedIn: false,
        email: null,
        serverUrl: 'http://localhost:8787',
        trackingOrigins: [],
      }),
    });
    mount(client, memoryPrefs(), () => (opened = true));
    await screen.findByText('Sign in to Postmark');
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(opened).toBe(true);
  });

  it('loading (skeleton) while messages load', async () => {
    const { client } = fakeBus({
      GET_AUTH_STATE: () => loggedIn,
      LIST_ACCOUNTS: () => ({ accounts: ACCOUNTS }),
      GET_ACTIVE_TAB_ACCOUNT: () => ({ account: null }),
      LIST_MESSAGES: () => new Promise(() => {}),
    });
    const { container } = mount(client);
    await waitFor(() => expect(container.querySelector('[data-state="loading"]')).toBeTruthy());
    expect(screen.getByLabelText('Loading').getAttribute('aria-busy')).toBe('true');
  });

  it('empty', async () => {
    const { client } = fakeBus({
      GET_AUTH_STATE: () => loggedIn,
      LIST_ACCOUNTS: () => ({ accounts: [] }),
      GET_ACTIVE_TAB_ACCOUNT: () => ({ account: null }),
      LIST_MESSAGES: () => ({ messages: [] }),
    });
    mount(client);
    await screen.findByText('No tracked emails yet');
  });

  it('error with retry', async () => {
    let calls = 0;
    const { client } = fakeBus({
      GET_AUTH_STATE: () => loggedIn,
      LIST_ACCOUNTS: () => ({ accounts: ACCOUNTS }),
      GET_ACTIVE_TAB_ACCOUNT: () => ({ account: null }),
      LIST_MESSAGES: () => {
        calls++;
        return calls === 1
          ? {
              ok: false as const,
              error: { code: 'SERVER' as const, message: 'Server error (500)' },
            }
          : { messages: [summary({ subject: 'Recovered' })] };
      },
    });
    mount(client);
    await screen.findByText('Something went wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Recovered');
  });

  it('offline (server unreachable)', async () => {
    const { client } = fakeBus({
      GET_AUTH_STATE: () => loggedIn,
      LIST_ACCOUNTS: () => ({
        ok: false as const,
        error: { code: 'NETWORK' as const, message: 'x' },
      }),
      GET_ACTIVE_TAB_ACCOUNT: () => ({ account: null }),
      LIST_MESSAGES: () => ({
        ok: false as const,
        error: { code: 'NETWORK' as const, message: 'Failed to fetch' },
      }),
    });
    const { container } = mount(client);
    await screen.findByText('Can’t reach your Postmark server');
    expect(container.querySelector('[data-state="offline"]')).toBeTruthy();
    expect(screen.getByText(/localhost:8787/)).toBeTruthy();
  });
});

describe('popup recent list', () => {
  it('lists messages; clicking one shows its full activity; Open in Gmail and Back work', async () => {
    const m1 = opened({
      id: 'm1',
      subject: 'Proposal',
      senderAccount: 'a@work.com',
      gmailThreadId: 'T1',
    });
    const m2 = summary({ subject: 'Dinner', senderAccount: 'b@gmail.com', gmailThreadId: null });
    const ev = (o: Partial<TrackingEvent>): TrackingEvent => ({
      id: 1,
      messageId: 'm1',
      linkId: null,
      linkUrl: null,
      type: 'open',
      occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
      uaClass: 'gmail_proxy',
      isFirst: true,
      senderAccount: 'a@work.com',
      subject: 'Proposal',
      recipients: ['you@example.com'],
      gmailThreadId: 'T1',
      ...o,
    });
    const { client, calls } = fakeBus({
      GET_AUTH_STATE: () => loggedIn,
      LIST_ACCOUNTS: () => ({ accounts: ACCOUNTS }),
      GET_ACTIVE_TAB_ACCOUNT: () => ({ account: null }),
      LIST_MESSAGES: () => ({ messages: [m1, m2] }),
      GET_MESSAGE_EVENTS: () => ({
        message: m1,
        events: [
          ev({ id: 1 }),
          ev({
            id: 2,
            type: 'click',
            linkUrl: 'https://example.com/doc',
            occurredAt: new Date().toISOString(),
          }),
          ev({ id: 3, uaClass: 'bot' }),
        ],
      }),
      OPEN_THREAD: () => ({ ok: true as const }),
    });
    mount(client);
    const list = await screen.findByRole('list', { name: 'Tracked emails' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Opened 3×')).toBeTruthy();
    expect(within(rows[0]!).getByText('via a@work.com')).toBeTruthy(); // chip
    expect(within(rows[1]!).getByText('Not opened yet')).toBeTruthy();

    fireEvent.click(rows[0]!);
    const timeline = await screen.findByRole('list', { name: /Activity history/ });
    const items = within(timeline).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Clicked example.com'),
      expect.stringContaining('Opened (in Gmail)'),
    ]);
    expect(screen.getByText(/Opens are most likely theirs/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 ignored event' }));
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Open in Gmail' }));
    await waitFor(() => expect(calls.some((c) => c.type === 'OPEN_THREAD')).toBe(true));
    expect(calls.find((c) => c.type === 'OPEN_THREAD')!.payload).toEqual({
      gmailThreadId: 'T1',
      account: 'a@work.com',
    });
    fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    await screen.findByRole('list', { name: 'Tracked emails' });
  });

  it('detail view shows an error with retry when history fails to load', async () => {
    let n = 0;
    const m = opened({ id: 'mx' });
    const { client } = fakeBus({
      GET_AUTH_STATE: () => loggedIn,
      LIST_ACCOUNTS: () => ({ accounts: [] }),
      GET_ACTIVE_TAB_ACCOUNT: () => ({ account: null }),
      LIST_MESSAGES: () => ({ messages: [m] }),
      GET_MESSAGE_EVENTS: () =>
        ++n === 1
          ? { ok: false as const, error: { code: 'NETWORK' as const, message: 'offline' } }
          : { message: m, events: [] },
    });
    mount(client);
    fireEvent.click(
      within(await screen.findByRole('list', { name: 'Tracked emails' })).getAllByRole(
        'button',
      )[0]!,
    );
    await screen.findByText(/Couldn’t load activity/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No activity yet.');
  });

  it('preselects the active Gmail tab’s account and hides chips', async () => {
    const { client, calls } = fakeBus({
      GET_AUTH_STATE: () => loggedIn,
      LIST_ACCOUNTS: () => ({ accounts: ACCOUNTS }),
      GET_ACTIVE_TAB_ACCOUNT: () => ({ account: 'b@gmail.com' }),
      LIST_MESSAGES: (p) => ({
        messages: [summary({ senderAccount: p.account ?? 'x@x.com', subject: 'From B' })],
      }),
    });
    mount(client, memoryPrefs({ popupAccount: 'a@work.com' }));
    await screen.findByText('From B');
    expect((screen.getByLabelText('Gmail account') as HTMLSelectElement).value).toBe('b@gmail.com');
    expect(calls.filter((c) => c.type === 'LIST_MESSAGES').pop()!.payload).toMatchObject({
      account: 'b@gmail.com',
    });
    expect(screen.queryByTitle('b@gmail.com')).toBeNull();
  });

  it('remembers the last selection when no Gmail tab is active', async () => {
    const prefs = memoryPrefs({ popupAccount: 'a@work.com' });
    const { client } = fakeBus({
      GET_AUTH_STATE: () => loggedIn,
      LIST_ACCOUNTS: () => ({ accounts: ACCOUNTS }),
      GET_ACTIVE_TAB_ACCOUNT: () => ({ account: null }),
      LIST_MESSAGES: () => ({ messages: [] }),
    });
    mount(client, prefs);
    await waitFor(() =>
      expect((screen.getByLabelText('Gmail account') as HTMLSelectElement).value).toBe(
        'a@work.com',
      ),
    );
    fireEvent.change(screen.getByLabelText('Gmail account'), { target: { value: ALL } });
    await waitFor(() => expect(prefs.data.popupAccount).toBe(ALL));
  });

  it('search filters via the SW query', async () => {
    const { client, calls } = fakeBus({
      GET_AUTH_STATE: () => loggedIn,
      LIST_ACCOUNTS: () => ({ accounts: ACCOUNTS }),
      GET_ACTIVE_TAB_ACCOUNT: () => ({ account: null }),
      LIST_MESSAGES: (p) => ({ messages: p.q ? [] : [summary()] }),
    });
    mount(client);
    await screen.findByRole('list', { name: 'Tracked emails' });
    fireEvent.input(screen.getByLabelText('Search recipient or subject'), {
      target: { value: 'nobody' },
    });
    await screen.findByText('No matches');
    expect(calls.filter((c) => c.type === 'LIST_MESSAGES').pop()!.payload).toMatchObject({
      q: 'nobody',
    });
  });
});

describe('popup reminders tab', () => {
  it('lists and deletes reminders; empty state after', async () => {
    const { client } = fakeBus({
      GET_AUTH_STATE: () => loggedIn,
      LIST_ACCOUNTS: () => ({ accounts: ACCOUNTS }),
      GET_ACTIVE_TAB_ACCOUNT: () => ({ account: null }),
      LIST_MESSAGES: () => ({ messages: [] }),
      LIST_REMINDERS: () => ({
        reminders: [
          {
            id: 'r1',
            messageId: 'm1',
            remindAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
            condition: 'no_reply' as const,
            status: 'pending' as const,
            createdAt: new Date().toISOString(),
            subject: 'Proposal',
            recipients: ['dana@client.com'],
            senderAccount: 'a@work.com',
            gmailThreadId: 'T1',
          },
        ],
      }),
      DELETE_REMINDER: () => ({ ok: true as const }),
    });
    mount(client);
    fireEvent.click(await screen.findByRole('tab', { name: 'Reminders' }));
    await screen.findByText('Proposal');
    expect(screen.getByText(/if no reply/)).toBeTruthy();
    expect(screen.getByText('in 3 d')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete reminder for Proposal' }));
    await screen.findByText('No reminders');
  });
});
