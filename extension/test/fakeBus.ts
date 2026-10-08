import type { BusReq, BusRes, BusResult, BusType } from '@postmark/shared';
import type { BusClient } from '../src/bus/client';

type Impl = {
  [K in BusType]?: (p: BusReq<K>) => BusRes<K> | Promise<BusRes<K>> | BusResult<BusRes<K>>;
};

/** A scripted BusClient for component tests. Return a `{ok:false,...}` object to simulate errors. */
export function fakeBus(impl: Impl) {
  const calls: { type: BusType; payload: unknown }[] = [];
  const client: BusClient = {
    async send(type, payload) {
      calls.push({ type, payload });
      const fn = impl[type] as ((p: unknown) => unknown) | undefined;
      if (!fn) return { ok: false, error: { code: 'UNKNOWN', message: `no fake for ${type}` } };
      const out = await fn(payload);
      if (
        out &&
        typeof out === 'object' &&
        'ok' in out &&
        (out as { ok: unknown }).ok === false &&
        'error' in out
      ) {
        return out as never;
      }
      return { ok: true, data: out } as never;
    },
  };
  return { client, calls };
}

export function memoryPrefs(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    data,
    async get<T>(k: string) {
      return data[k] as T | undefined;
    },
    async set(k: string, v: unknown) {
      data[k] = v;
    },
  };
}
