import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { notificationOptions, type NotificationSpec } from '../src/background/notify';
import { PermissionsBanner } from '../src/ui/components/PermissionsBanner';
import { GMAIL_PATTERN, originPattern, type HostPermissions } from '../src/ui/permissions';

const SERVER = 'https://pm.example.com';

describe('notificationOptions', () => {
  const spec: NotificationSpec = {
    id: 'pm:open:m1',
    kind: 'open',
    title: 'Opened',
    message: 'Hello',
    contextMessage: 'via a@work.com',
    messageId: 'm1',
    threadId: 't1',
    account: 'a@work.com',
  };

  it('chrome keeps contextMessage and priority', () => {
    expect(notificationOptions(spec, 'icon.png', false)).toEqual({
      type: 'basic',
      iconUrl: 'icon.png',
      title: 'Opened',
      message: 'Hello',
      contextMessage: 'via a@work.com',
      priority: 0,
    });
  });

  it('firefox folds contextMessage into message and drops unsupported keys', () => {
    expect(notificationOptions(spec, 'icon.png', true)).toEqual({
      type: 'basic',
      iconUrl: 'icon.png',
      title: 'Opened',
      message: 'Hello\nvia a@work.com',
    });
    const { contextMessage: _omit, ...plain } = spec;
    expect(notificationOptions(plain, 'icon.png', true).message).toBe('Hello');
  });
});

describe('PermissionsBanner', () => {
  function perms(initiallyMissing: string[], grant: boolean) {
    let missing = [...initiallyMissing];
    const requested: string[][] = [];
    const p: HostPermissions = {
      missing: async () => missing,
      request: async (patterns) => {
        requested.push(patterns);
        if (grant) missing = [];
        return grant;
      },
    };
    return { p, requested };
  }

  it('renders nothing when everything is granted', async () => {
    const { p } = perms([], true);
    const { container } = render(<PermissionsBanner serverUrl={SERVER} permissions={p} />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('requests the missing patterns and disappears once granted', async () => {
    const { p, requested } = perms([GMAIL_PATTERN, originPattern(SERVER)], true);
    let granted = 0;
    render(<PermissionsBanner serverUrl={SERVER} permissions={p} onGranted={() => granted++} />);
    expect(await screen.findByText(/can’t access Gmail or your Postmark server/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(requested).toEqual([[GMAIL_PATTERN, 'https://pm.example.com/*']]);
    expect(granted).toBe(1);
  });

  it('stays up with a note when the user declines', async () => {
    const { p } = perms([GMAIL_PATTERN], false);
    render(<PermissionsBanner serverUrl={SERVER} permissions={p} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Grant access' }));
    expect(await screen.findByText(/wasn’t granted/)).toBeTruthy();
  });

  it('delegates to onGrant (popup → settings) instead of prompting', async () => {
    const { p, requested } = perms([GMAIL_PATTERN], true);
    let opened = 0;
    render(<PermissionsBanner serverUrl={SERVER} permissions={p} onGrant={() => opened++} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix in settings' }));
    expect(opened).toBe(1);
    expect(requested).toEqual([]);
  });
});
