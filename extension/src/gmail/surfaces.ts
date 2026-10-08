import type { PushMap } from '@postmark/shared';
import type { BusClient } from '../bus/client';
import type { GmailAdapter } from './adapter';

export interface SurfaceDeps {
  adapter: GmailAdapter;
  bus: BusClient;
  account: string | null;
  onUpdate: (fn: (p: PushMap['DATA_UPDATED']) => void) => () => void;
}

/** Sent-list marks and thread strips (implemented in stage E3). */
export function startGmailSurfaces(_deps: SurfaceDeps): void {}
