import './installGuard'; // must stay the first import (privacy guard for InboxSDK telemetry)
import { isPushEnvelope, normalizeAccount, type PushMap } from '@postmark/shared';
import { createBusClient } from '../bus/client';
import { INBOXSDK_APP_ID } from '../config';
import { attachCompose } from './compose';
import { loadInboxSdkAdapter } from './inboxsdkAdapter';
import { logOnce } from './safe';
import { startGmailSurfaces } from './surfaces';

type UpdateListener = (p: PushMap['DATA_UPDATED']) => void;

async function main(): Promise<void> {
  const bus = createBusClient();
  const listeners = new Set<UpdateListener>();
  chrome.runtime.onMessage.addListener((msg: unknown) => {
    if (isPushEnvelope(msg) && msg.type === 'DATA_UPDATED') {
      for (const l of listeners) l(msg.payload);
    }
    return undefined;
  });

  let adapter;
  try {
    adapter = await loadInboxSdkAdapter(INBOXSDK_APP_ID);
  } catch (err) {
    // Fail soft: Gmail keeps working, the popup still works; tracking just isn't offered here.
    logOnce('InboxSDK failed to load; Gmail integration disabled', err);
    return;
  }

  const account = normalizeAccount(adapter.getUserEmail());
  if (!account) logOnce('could not determine the Gmail account for this tab');
  const aliases = new Set<string>();
  const report = () => {
    if (account) void bus.send('ACTIVE_ACCOUNT', { account, aliases: [...aliases] });
  };
  report();
  // Re-report when the tab regains focus: the SW may have restarted or the extension reloaded.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') report();
  });

  adapter.onCompose((compose) => {
    attachCompose(compose, {
      bus,
      adapter,
      tabAccount: account,
      onAliases: (seen) => {
        let changed = false;
        for (const a of seen) {
          if (a !== account && !aliases.has(a)) {
            aliases.add(a);
            changed = true;
          }
        }
        if (changed) report();
      },
    });
  });

  // Aliases learned in earlier sessions (persisted by the SW) widen this tab's scope immediately.
  const stored = await chrome.storage.local.get('accountAliases');
  const known =
    (stored.accountAliases as Record<string, string[]> | undefined)?.[account ?? ''] ?? [];
  known.forEach((a) => aliases.add(a));

  startGmailSurfaces({
    adapter,
    bus,
    account,
    aliases: () => [...aliases],
    onUpdate: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
}

void main();
