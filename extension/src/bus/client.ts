import type { BusEnvelope, BusReq, BusRes, BusResult, BusType } from '@postmark/shared';

/** Abstraction over chrome.runtime.sendMessage so callers (and tests) don't touch chrome.* directly. */
export type BusTransport = (envelope: BusEnvelope) => Promise<unknown>;

export interface BusClient {
  send<K extends BusType>(
    type: K,
    payload: BusReq<K>,
    opts?: { timeoutMs?: number },
  ): Promise<BusResult<BusRes<K>>>;
}

export const chromeTransport: BusTransport = (envelope) => chrome.runtime.sendMessage(envelope);

function isBusResult(x: unknown): x is BusResult<unknown> {
  return typeof x === 'object' && x !== null && typeof (x as { ok?: unknown }).ok === 'boolean';
}

export function createBusClient(transport: BusTransport = chromeTransport): BusClient {
  return {
    async send(type, payload, opts) {
      const envelope = { __postmark: 1, type, payload } as BusEnvelope;
      const call = transport(envelope).then((raw): BusResult<never> => {
        if (isBusResult(raw)) return raw as BusResult<never>;
        return {
          ok: false,
          error: { code: 'UNKNOWN', message: 'No response from service worker' },
        };
      });
      const guarded = call.catch(
        (err: unknown): BusResult<never> => ({
          ok: false,
          error: {
            code: 'NETWORK',
            message: err instanceof Error ? err.message : 'Extension messaging failed',
          },
        }),
      );
      if (!opts?.timeoutMs) return guarded;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<BusResult<never>>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, error: { code: 'TIMEOUT', message: 'Timed out' } }),
          opts.timeoutMs,
        );
      });
      try {
        return await Promise.race([guarded, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
