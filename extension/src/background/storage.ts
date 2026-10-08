import type { AccountInfo, GlobalSettings } from '@postmark/shared';

export interface NotificationTarget {
  threadId: string | null;
  account: string;
}

export interface QueuedNote {
  kind: 'open' | 'click' | 'reminder';
  messageId: string;
  subject: string;
}

/** Everything the extension persists in chrome.storage.local. The token never leaves the SW. */
export interface LocalState {
  auth: { token: string; email: string };
  serverUrl: string;
  globalSettings: Partial<GlobalSettings>;
  accountsCache: AccountInfo[];
  pollCursor: string;
  /** Every Gmail account / alias the extension has seen, for the options page. */
  knownAccounts: string[];
  /** primary tab account → "Send as" aliases seen in its compose windows. */
  accountAliases: Record<string, string[]>;
  popupAccount: string | null;
  stripCollapsed: boolean;
  quietQueue: QueuedNote[];
  notifTargets: Record<string, NotificationTarget>;
  lastPoll: { at: number; ok: boolean; error?: string };
}

export interface TabScope {
  account: string;
  aliases: string[];
}

export interface SessionState {
  tabAccounts: Record<string, TabScope>;
}

export async function getLocal<K extends keyof LocalState>(
  key: K,
): Promise<LocalState[K] | undefined> {
  const r = await chrome.storage.local.get(key);
  return r[key] as LocalState[K] | undefined;
}

export async function setLocal(patch: Partial<LocalState>): Promise<void> {
  await chrome.storage.local.set(patch);
}

export async function removeLocal(keys: (keyof LocalState)[]): Promise<void> {
  await chrome.storage.local.remove(keys);
}

export async function getSession<K extends keyof SessionState>(
  key: K,
): Promise<SessionState[K] | undefined> {
  const r = await chrome.storage.session.get(key);
  return r[key] as SessionState[K] | undefined;
}

export async function setSession(patch: Partial<SessionState>): Promise<void> {
  await chrome.storage.session.set(patch);
}

/** Serialise read-modify-write updates within this SW instance. */
let chain: Promise<unknown> = Promise.resolve();
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}
