import {
  isBusEnvelope,
  type BusError,
  type BusErrorCode,
  type BusReq,
  type BusRes,
  type BusResult,
  type BusType,
} from '@postmark/shared';

export interface HandlerContext {
  /** Tab id when the message came from a content script; undefined for popup/options. */
  tabId: number | undefined;
  /** True when sent from an extension page (popup/options), false from a content script. */
  fromExtensionPage: boolean;
}

export type Handlers = {
  [K in BusType]: (payload: BusReq<K>, ctx: HandlerContext) => Promise<BusRes<K>>;
};

/** Thrown by handlers to produce a typed error envelope. */
export class HandlerError extends Error {
  constructor(
    readonly code: BusErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function toBusError(err: unknown): BusError {
  if (err instanceof HandlerError) return { code: err.code, message: err.message };
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    'message' in err
  ) {
    return { code: (err as BusError).code, message: String((err as BusError).message) };
  }
  return { code: 'UNKNOWN', message: err instanceof Error ? err.message : 'Unknown error' };
}

/** Content scripts may only use this subset; everything else is popup/options-only. */
export const CONTENT_SCRIPT_TYPES: ReadonlySet<BusType> = new Set<BusType>([
  'ACTIVE_ACCOUNT',
  'PREPARE_TRACKING',
  'BIND_SENT',
  'GET_MARKS',
  'GET_THREAD_TRACKING',
  'SELF_VIEW',
  'GET_MESSAGE_EVENTS',
  'REPORT_REPLY',
  'GET_SETTINGS',
  'GET_AUTH_STATE',
  'CREATE_REMINDER',
]);

export interface SenderLike {
  id?: string;
  tab?: { id?: number };
  url?: string;
}

export async function dispatch(
  handlers: Handlers,
  message: unknown,
  sender: SenderLike,
  extensionId: string,
): Promise<BusResult<unknown>> {
  if (!isBusEnvelope(message)) {
    return { ok: false, error: { code: 'VALIDATION', message: 'Not a Postmark message' } };
  }
  if (sender.id !== extensionId) {
    return { ok: false, error: { code: 'VALIDATION', message: 'Unknown sender' } };
  }
  // Extension pages (popup, options — even when opened in a tab) have our own origin;
  // anything else is a content script running inside a web page (Gmail).
  const fromExtensionPage =
    typeof sender.url === 'string' && sender.url.startsWith(`chrome-extension://${extensionId}/`);
  if (!fromExtensionPage && !CONTENT_SCRIPT_TYPES.has(message.type)) {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: `${message.type} not allowed here` },
    };
  }
  const handler = handlers[message.type] as
    | ((p: unknown, c: HandlerContext) => Promise<unknown>)
    | undefined;
  if (!handler) {
    return { ok: false, error: { code: 'VALIDATION', message: `Unknown type ${message.type}` } };
  }
  try {
    const tabId = fromExtensionPage ? undefined : sender.tab?.id;
    const data = await handler(message.payload, { tabId, fromExtensionPage });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: toBusError(err) };
  }
}

/** chrome.runtime.onMessage listener. Returns true to keep the channel open for async replies. */
export function createRouter(handlers: Handlers, extensionId: string) {
  return (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: BusResult<unknown>) => void,
  ): boolean | undefined => {
    if (!isBusEnvelope(message)) return undefined; // not ours (e.g. InboxSDK's own messages)
    void dispatch(handlers, message, sender, extensionId).then(sendResponse);
    return true;
  };
}
