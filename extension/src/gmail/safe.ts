/** Fail-soft helpers: Gmail hooks must never take the page (or sending) down. */

const logged = new Set<string>();

/**
 * False once this content script is orphaned (the extension was reloaded or updated while the
 * Gmail tab stayed open). Orphaned scripts must go quiet: every chrome.* call would throw
 * "Extension context invalidated" until the user reloads Gmail.
 */
export function extensionAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

export function isContextInvalidated(err: unknown): boolean {
  return err instanceof Error && /Extension context invalidated/i.test(err.message);
}

export function logOnce(key: string, ...args: unknown[]): void {
  if (logged.has(key)) return;
  if (!extensionAlive() || args.some(isContextInvalidated)) return; // orphaned: stay silent
  logged.add(key);
  console.warn(`[postmark] ${key}`, ...args);
}

export function safe<A extends unknown[]>(key: string, fn: (...a: A) => void): (...a: A) => void {
  return (...a: A) => {
    try {
      fn(...a);
    } catch (err) {
      logOnce(key, err);
    }
  };
}

export async function safeAsync<T>(key: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logOnce(key, err);
    return fallback;
  }
}

/** Minimal Kefir-compatible live value (InboxSDK accepts anything with onAny/offAny). */
export class LiveValue<T> {
  private listeners = new Set<(e: { type: 'value'; value: T }) => void>();
  constructor(private current: T) {}
  get value(): T {
    return this.current;
  }
  set(v: T): void {
    this.current = v;
    for (const l of this.listeners) l({ type: 'value', value: v });
  }
  onAny(fn: (e: { type: 'value'; value: T }) => void): void {
    this.listeners.add(fn);
    fn({ type: 'value', value: this.current });
  }
  offAny(fn: (e: { type: 'value'; value: T }) => void): void {
    this.listeners.delete(fn);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
