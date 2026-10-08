import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { createBusClient, type BusClient } from '../bus/client';

export const BusContext = createContext<BusClient | null>(null);

let defaultClient: BusClient | null = null;

export function useBus(): BusClient {
  const fromCtx = useContext(BusContext);
  if (fromCtx) return fromCtx;
  defaultClient ??= createBusClient();
  return defaultClient;
}

/** Small key/value persistence for UI preferences; injectable for tests. */
export interface UiPrefs {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export const chromePrefs: UiPrefs = {
  async get<T>(key: string) {
    const r = await chrome.storage.local.get(key);
    return r[key] as T | undefined;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};

export const PrefsContext = createContext<UiPrefs>(chromePrefs);
export const usePrefs = () => useContext(PrefsContext);
