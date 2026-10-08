import { describe, expect, it } from 'vitest';
import { createBusClient, call, BusFailure } from '../src/bus/client';
import { dispatch, HandlerError, type Handlers } from '../src/bus/router';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';

function handlers(overrides: Partial<Handlers>): Handlers {
  return overrides as Handlers;
}

describe('bus router', () => {
  it('routes to the handler and wraps data', async () => {
    const h = handlers({
      GET_AUTH_STATE: async () => ({ loggedIn: true, email: 'a@b.com', serverUrl: 's' }),
    });
    const r = await dispatch(
      h,
      { __postmark: 1, type: 'GET_AUTH_STATE', payload: {} },
      { id: EXT, url: `chrome-extension://${EXT}/popup.html` },
      EXT,
    );
    expect(r).toEqual({ ok: true, data: { loggedIn: true, email: 'a@b.com', serverUrl: 's' } });
  });

  it('maps HandlerError to a typed error envelope', async () => {
    const h = handlers({
      LOGOUT: async () => {
        throw new HandlerError('NOT_AUTHENTICATED', 'nope');
      },
    });
    const r = await dispatch(
      h,
      { __postmark: 1, type: 'LOGOUT', payload: {} },
      { id: EXT, url: `chrome-extension://${EXT}/x` },
      EXT,
    );
    expect(r).toEqual({ ok: false, error: { code: 'NOT_AUTHENTICATED', message: 'nope' } });
  });

  it('rejects messages from other extensions and non-envelopes', async () => {
    const h = handlers({});
    expect((await dispatch(h, { hello: 1 }, { id: EXT }, EXT)).ok).toBe(false);
    const r = await dispatch(
      h,
      { __postmark: 1, type: 'LOGOUT', payload: {} },
      { id: 'other' },
      EXT,
    );
    expect(r.ok).toBe(false);
  });

  it('content scripts cannot call privileged messages (e.g. DELETE_ME, LIST_MESSAGES)', async () => {
    let called = false;
    const h = handlers({
      DELETE_ME: async () => {
        called = true;
        return { ok: true };
      },
    });
    const r = await dispatch(
      h,
      { __postmark: 1, type: 'DELETE_ME', payload: {} },
      { id: EXT, tab: { id: 3 } },
      EXT,
    );
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('extension pages opened in a tab (options page) keep privileged access and no tab scope', async () => {
    let ctxSeen: unknown;
    const h = handlers({
      DELETE_ME: async (_p, ctx) => {
        ctxSeen = ctx;
        return { ok: true };
      },
    });
    const r = await dispatch(
      h,
      { __postmark: 1, type: 'DELETE_ME', payload: {} },
      { id: EXT, tab: { id: 5 }, url: `chrome-extension://${EXT}/options.html` },
      EXT,
    );
    expect(r.ok).toBe(true);
    expect(ctxSeen).toEqual({ tabId: undefined, fromExtensionPage: true });
  });

  it('a content script cannot spoof an extension-page URL of another extension', async () => {
    const r = await dispatch(
      handlers({ DELETE_ME: async () => ({ ok: true }) }),
      { __postmark: 1, type: 'DELETE_ME', payload: {} },
      { id: EXT, tab: { id: 5 }, url: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/x' },
      EXT,
    );
    expect(r.ok).toBe(false);
  });

  it('unknown types are rejected', async () => {
    const r = await dispatch(
      handlers({}),
      { __postmark: 1, type: 'NOPE', payload: {} },
      { id: EXT, url: `chrome-extension://${EXT}/x` },
      EXT,
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });

  it('passes tab id to handlers', async () => {
    let seen: number | undefined;
    const h = handlers({
      ACTIVE_ACCOUNT: async (_p, ctx) => {
        seen = ctx.tabId;
        return { ok: true };
      },
    });
    await dispatch(
      h,
      { __postmark: 1, type: 'ACTIVE_ACCOUNT', payload: { account: 'a@b.com' } },
      { id: EXT, tab: { id: 42 } },
      EXT,
    );
    expect(seen).toBe(42);
  });
});

describe('bus client', () => {
  it('times out with a TIMEOUT error', async () => {
    const client = createBusClient(() => new Promise(() => {}));
    const r = await client.send('GET_AUTH_STATE', {}, { timeoutMs: 20 });
    expect(r).toEqual({ ok: false, error: { code: 'TIMEOUT', message: 'Timed out' } });
  });

  it('maps transport failures to NETWORK', async () => {
    const client = createBusClient(() =>
      Promise.reject(new Error('Extension context invalidated')),
    );
    const r = await client.send('GET_AUTH_STATE', {});
    expect(r).toMatchObject({ ok: false, error: { code: 'NETWORK' } });
  });

  it('treats a missing response as UNKNOWN', async () => {
    const client = createBusClient(() => Promise.resolve(undefined));
    expect(await client.send('GET_AUTH_STATE', {})).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN' },
    });
  });

  it('call() unwraps or throws BusFailure', async () => {
    const ok = createBusClient(() => Promise.resolve({ ok: true, data: { ok: true } }));
    expect(await call(ok, 'LOGOUT', {})).toEqual({ ok: true });
    const bad = createBusClient(() =>
      Promise.resolve({ ok: false, error: { code: 'SERVER', message: 'x' } }),
    );
    await expect(call(bad, 'LOGOUT', {})).rejects.toBeInstanceOf(BusFailure);
  });
});
