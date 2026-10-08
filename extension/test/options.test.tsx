import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { BUILTIN_DEFAULTS, type GlobalSettings } from '@postmark/shared';
import type { BusClient } from '../src/bus/client';
import { BusContext } from '../src/ui/busContext';
import { Options } from '../src/ui/options/Options';
import { fakeBus } from './fakeBus';

function mount(bus: BusClient, grant = true) {
  return render(
    <BusContext.Provider value={bus}>
      <Options requestHostPermission={async () => grant} />
    </BusContext.Provider>,
  );
}

function scripted(loggedIn: boolean) {
  const state = { loggedIn, global: { ...BUILTIN_DEFAULTS } as GlobalSettings };
  const accounts = [
    {
      account: 'a@work.com',
      messageCount: 3,
      lastSentAt: null,
      settings: { trackingDefault: false },
    },
    { account: 'b@gmail.com', messageCount: 0, lastSentAt: null, settings: {} },
  ];
  const bus = fakeBus({
    GET_AUTH_STATE: () => ({
      loggedIn: state.loggedIn,
      email: state.loggedIn ? 'me@x.com' : null,
      serverUrl: 'http://localhost:8787',
      trackingOrigins: [],
    }),
    GET_SETTINGS: () => ({ global: state.global, account: null, resolved: state.global }),
    UPDATE_GLOBAL_SETTINGS: (p) => (state.global = { ...state.global, ...p }),
    LIST_ACCOUNTS: () => ({ accounts }),
    UPDATE_ACCOUNT_SETTINGS: (p) => ({
      ...accounts.find((a) => a.account === p.account)!,
      settings: {},
    }),
    SET_SERVER_URL: (p) => ({ serverUrl: p.serverUrl }),
    REGISTER: (p) => {
      state.loggedIn = true;
      return { email: p.email };
    },
    CONNECT_TOKEN: () => {
      state.loggedIn = true;
      return { email: 'seed@x.com' };
    },
    LOGOUT: () => {
      state.loggedIn = false;
      return { ok: true as const };
    },
    DELETE_ME: () => {
      state.loggedIn = false;
      return { ok: true as const };
    },
  });
  return { ...bus, state };
}

describe('options page', () => {
  it('registers when logged out, then shows accounts', async () => {
    const { client, calls } = scripted(false);
    mount(client);
    await screen.findByText(/Not signed in/);
    fireEvent.input(screen.getByLabelText('Email for your Postmark account'), {
      target: { value: 'me@x.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await screen.findByText('Registered me@x.com.');
    expect(calls.find((c) => c.type === 'REGISTER')!.payload).toEqual({
      email: 'me@x.com',
      serverUrl: 'http://localhost:8787',
    });
    await screen.findByText('Gmail accounts');
  });

  it('refuses to proceed without host permission for the server', async () => {
    const { client, calls } = scripted(false);
    mount(client, false);
    await screen.findByText(/Not signed in/);
    fireEvent.input(screen.getByLabelText('Email for your Postmark account'), {
      target: { value: 'me@x.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    await screen.findByText(/permission/);
    expect(calls.some((c) => c.type === 'REGISTER')).toBe(false);
  });

  it('connects with an existing token', async () => {
    const { client } = scripted(false);
    mount(client);
    await screen.findByText(/Not signed in/);
    fireEvent.input(screen.getByLabelText(/Token/), {
      target: { value: 'tok_abcdefghijklmnopqrstuvwxyz' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText('Connected as seed@x.com.');
  });

  it('per-account settings: tri-state selects send overrides or clear them', async () => {
    const { client, calls } = scripted(true);
    mount(client);
    const table = await screen.findByRole('table');
    const workSelect = within(table).getByLabelText(
      'Track by default for a@work.com',
    ) as HTMLSelectElement;
    expect(workSelect.value).toBe('off');
    fireEvent.change(workSelect, { target: { value: 'global' } });
    await waitFor(() => expect(calls.some((c) => c.type === 'UPDATE_ACCOUNT_SETTINGS')).toBe(true));
    expect(calls.find((c) => c.type === 'UPDATE_ACCOUNT_SETTINGS')!.payload).toEqual({
      account: 'a@work.com',
      settings: { trackingDefault: null },
    });
    fireEvent.change(within(table).getByLabelText('Notifications for b@gmail.com'), {
      target: { value: 'off' },
    });
    await waitFor(() =>
      expect(calls.filter((c) => c.type === 'UPDATE_ACCOUNT_SETTINGS').pop()!.payload).toEqual({
        account: 'b@gmail.com',
        settings: { notificationsEnabled: false },
      }),
    );
  });

  it('global toggles and quiet hours', async () => {
    const { client, state } = scripted(true);
    mount(client);
    const footer = (await screen.findByLabelText(/Add a disclosure line/)) as HTMLInputElement;
    expect(footer.checked).toBe(false);
    fireEvent.click(footer);
    await waitFor(() => expect(state.global.disclosureFooter).toBe(true));
    fireEvent.click(screen.getByLabelText(/Quiet hours/));
    await waitFor(() => expect(state.global.quietHours).toEqual({ start: '22:00', end: '07:00' }));
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '21:30' } });
    await waitFor(() => expect(state.global.quietHours).toEqual({ start: '21:30', end: '07:00' }));
  });

  it('delete my data requires an explicit confirmation', async () => {
    const { client, calls } = scripted(true);
    mount(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my data…' }));
    expect(calls.some((c) => c.type === 'DELETE_ME')).toBe(false);
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, delete everything' }));
    await screen.findByText('All your data was deleted.');
    expect(calls.some((c) => c.type === 'DELETE_ME')).toBe(true);
  });

  it('includes the privacy explainer', async () => {
    const { client } = scripted(false);
    mount(client);
    await screen.findByText(/Never the email body/);
    expect(screen.getByText(/probabilistic/)).toBeTruthy();
  });
});
