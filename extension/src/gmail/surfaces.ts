import { normalizeAccount, type PushMap } from '@postmark/shared';
import type { BusClient } from '../bus/client';
import type { GmailAdapter } from './adapter';
import { startListMarks } from './listMarks';
import { startThreadStrips } from './threadStrip';

export interface SurfaceDeps {
  adapter: GmailAdapter;
  bus: BusClient;
  account: string | null;
  /** Aliases discovered so far in this tab (grows as composes reveal "Send as" addresses). */
  aliases: () => string[];
  onUpdate: (fn: (p: PushMap['DATA_UPDATED']) => void) => () => void;
}

const ICONS = {
  sent: 'icons/mark-sent.svg',
  opened: 'icons/mark-opened.svg',
  auto: 'icons/mark-auto.svg',
  click: 'icons/mark-click.svg',
} as const;

/** Sent-list marks and thread strips. Each surface fails soft on its own. */
export function startGmailSurfaces(deps: SurfaceDeps): void {
  if (!deps.account) return; // without the tab's account we can't scope data safely
  const primary = deps.account;
  startListMarks({
    adapter: deps.adapter,
    bus: deps.bus,
    iconUrl: (name) => chrome.runtime.getURL(ICONS[name]),
    onUpdate: deps.onUpdate,
  });
  startThreadStrips({
    adapter: deps.adapter,
    bus: deps.bus,
    scope: () =>
      [primary, ...deps.aliases()].map(normalizeAccount).filter((a): a is string => a !== null),
    onUpdate: deps.onUpdate,
  });
}
