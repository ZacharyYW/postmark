import type { ReminderCondition } from './constants';
import type {
  AccountInfo,
  AccountSettings,
  CreateMessageRes,
  MessageSummary,
  Reminder,
} from './schemas';
import type { GlobalSettings, ResolvedSettings } from './settings';

/**
 * Typed message bus between content script / popup / options and the service worker.
 * Each entry maps a message type to its request payload and its response data.
 *
 * For content-script requests the service worker resolves the Gmail account from the sending
 * tab (`sender.tab.id` → tab-account map). Account fields in those payloads are not trusted.
 */
export interface BusMap {
  /** Content script → SW on load: the tab's Gmail account plus any "Send as" aliases seen there. */
  ACTIVE_ACCOUNT: { req: { account: string; aliases?: string[] }; res: { ok: true } };
  PREPARE_TRACKING: {
    req: {
      clientRequestId: string;
      senderAccount: string;
      subject: string;
      recipients: string[];
      links: string[];
    };
    res: CreateMessageRes;
  };
  BIND_SENT: {
    req: { messageId: string; gmailThreadId: string | null; gmailMessageId: string | null };
    res: { ok: true };
  };
  GET_MARKS: { req: { threadIds: string[] }; res: { marks: Record<string, MessageSummary[]> } };
  GET_THREAD_TRACKING: { req: { threadId: string }; res: { messages: MessageSummary[] } };
  SELF_VIEW: { req: { messageId: string }; res: { ok: true } };
  REPORT_REPLY: { req: { messageId: string }; res: { ok: true } };
  GET_SETTINGS: {
    req: { account?: string | null };
    res: { global: GlobalSettings; account: AccountSettings | null; resolved: ResolvedSettings };
  };
  UPDATE_GLOBAL_SETTINGS: { req: Partial<GlobalSettings>; res: GlobalSettings };
  UPDATE_ACCOUNT_SETTINGS: {
    req: {
      account: string;
      settings: {
        trackingDefault?: boolean | null;
        notificationsEnabled?: boolean | null;
        quietHours?: { start: string; end: string } | null;
      };
    };
    res: AccountInfo;
  };
  GET_AUTH_STATE: {
    req: Record<string, never>;
    res: { loggedIn: boolean; email: string | null; serverUrl: string };
  };
  REGISTER: { req: { email: string; serverUrl?: string }; res: { email: string } };
  /** Sign in with an existing token (e.g. the one printed by `npm run seed`). */
  CONNECT_TOKEN: { req: { token: string; serverUrl?: string }; res: { email: string } };
  LOGOUT: { req: Record<string, never>; res: { ok: true } };
  DELETE_ME: { req: Record<string, never>; res: { ok: true } };
  SET_SERVER_URL: { req: { serverUrl: string }; res: { serverUrl: string } };
  LIST_MESSAGES: {
    req: { account?: string | null; limit?: number; q?: string };
    res: { messages: MessageSummary[] };
  };
  LIST_ACCOUNTS: { req: Record<string, never>; res: { accounts: AccountInfo[] } };
  LIST_REMINDERS: { req: { account?: string | null }; res: { reminders: Reminder[] } };
  CREATE_REMINDER: {
    req: { messageId: string; remindAt: string; condition: ReminderCondition };
    res: Reminder;
  };
  DELETE_REMINDER: { req: { id: string }; res: { ok: true } };
  GET_ACTIVE_TAB_ACCOUNT: { req: Record<string, never>; res: { account: string | null } };
  OPEN_THREAD: { req: { gmailThreadId: string; account: string | null }; res: { ok: true } };
}

export type BusType = keyof BusMap;
export type BusReq<K extends BusType> = BusMap[K]['req'];
export type BusRes<K extends BusType> = BusMap[K]['res'];

export interface BusEnvelope<K extends BusType = BusType> {
  __postmark: 1;
  type: K;
  payload: BusReq<K>;
}

export const BUS_ERROR_CODES = [
  'NOT_AUTHENTICATED',
  'NETWORK',
  'TIMEOUT',
  'SERVER',
  'VALIDATION',
  'NO_ACCOUNT',
  'NOT_FOUND',
  'UNKNOWN',
] as const;
export type BusErrorCode = (typeof BUS_ERROR_CODES)[number];

export interface BusError {
  code: BusErrorCode;
  message: string;
}

export type BusResult<T> = { ok: true; data: T } | { ok: false; error: BusError };

/** Push messages from the service worker to Gmail tabs. */
export interface PushMap {
  DATA_UPDATED: { messageIds: string[]; threadIds: string[] };
}
export type PushType = keyof PushMap;
export interface PushEnvelope<K extends PushType = PushType> {
  __postmarkPush: 1;
  type: K;
  payload: PushMap[K];
}

export function isBusEnvelope(x: unknown): x is BusEnvelope {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { __postmark?: unknown }).__postmark === 1 &&
    typeof (x as { type?: unknown }).type === 'string'
  );
}

export function isPushEnvelope(x: unknown): x is PushEnvelope {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { __postmarkPush?: unknown }).__postmarkPush === 1 &&
    typeof (x as { type?: unknown }).type === 'string'
  );
}
