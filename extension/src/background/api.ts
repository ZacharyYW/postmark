import {
  AccountInfo,
  AccountsRes,
  CreateMessageRes,
  EventsRes,
  ListMessagesRes,
  MessageSummary,
  MeRes,
  RegisterRes,
  Reminder,
  RemindersRes,
  type BusErrorCode,
  type CreateMessageReq,
  type CreateReminderReq,
  type PatchAccountReq,
  type ReminderStatus,
} from '@postmark/shared';
import type { ZodType, ZodTypeDef } from 'zod';
import { HandlerError } from '../bus/router';

export interface ApiConfig {
  baseUrl: string;
  token: string | null;
}

export interface RequestOpts<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
  schema?: ZodType<T, ZodTypeDef, unknown>;
  query?: Record<string, string | number | undefined | null>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** The only module that talks to the network. Errors are mapped to bus error codes. */
export class ApiClient {
  constructor(
    private readonly config: () => Promise<ApiConfig>,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async request<T>(path: string, opts: RequestOpts<T> = {}): Promise<T> {
    const { baseUrl, token } = await this.config();
    const auth = opts.auth ?? true;
    if (auth && !token) throw new HandlerError('NOT_AUTHENTICATED', 'Not signed in to Postmark');
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? null : JSON.stringify(opts.body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      if (controller.signal.aborted)
        throw new HandlerError('TIMEOUT', 'Server did not respond in time');
      throw new HandlerError(
        'NETWORK',
        `Could not reach the Postmark server (${(err as Error).message})`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) return undefined as T;
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      const code: BusErrorCode =
        res.status === 401
          ? 'NOT_AUTHENTICATED'
          : res.status === 404
            ? 'NOT_FOUND'
            : res.status === 400 || res.status === 409 || res.status === 413
              ? 'VALIDATION'
              : 'SERVER';
      const message =
        (json as { error?: { message?: string } } | null)?.error?.message ??
        `Server error (${res.status})`;
      throw new HandlerError(code, message);
    }
    if (opts.schema) {
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) throw new HandlerError('SERVER', 'Unexpected response from server');
      return parsed.data;
    }
    return json as T;
  }

  // ---------- typed endpoints ----------
  register(email: string, baseUrlOverride?: string) {
    if (baseUrlOverride) {
      return new ApiClient(
        async () => ({ baseUrl: baseUrlOverride, token: null }),
        this.fetchImpl,
      ).request('/v1/auth/register', {
        method: 'POST',
        body: { email },
        auth: false,
        schema: RegisterRes,
      });
    }
    return this.request('/v1/auth/register', {
      method: 'POST',
      body: { email },
      auth: false,
      schema: RegisterRes,
    });
  }
  me() {
    return this.request('/v1/me', { schema: MeRes });
  }
  deleteMe() {
    return this.request<void>('/v1/me', { method: 'DELETE' });
  }
  createMessage(body: CreateMessageReq, timeoutMs: number) {
    return this.request('/v1/messages', {
      method: 'POST',
      body,
      timeoutMs,
      schema: CreateMessageRes,
    });
  }
  bindMessage(
    id: string,
    body: { gmailThreadId?: string; gmailMessageId?: string; repliedAt?: string },
  ) {
    return this.request(`/v1/messages/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
      schema: MessageSummary,
    });
  }
  listMessages(q: {
    account?: string | null;
    accounts?: string[];
    limit?: number;
    q?: string;
    threadIds?: string[];
  }) {
    return this.request('/v1/messages', {
      schema: ListMessagesRes,
      query: {
        account: q.account ?? undefined,
        accounts: q.accounts?.join(','),
        limit: q.limit,
        q: q.q,
        threadIds: q.threadIds?.join(','),
      },
    });
  }
  getMessage(id: string) {
    return this.request(`/v1/messages/${encodeURIComponent(id)}`, { schema: MessageSummary });
  }
  selfView(id: string, account: string) {
    return this.request<void>(`/v1/messages/${encodeURIComponent(id)}/self-view`, {
      method: 'POST',
      body: { account },
    });
  }
  accounts() {
    return this.request('/v1/accounts', { schema: AccountsRes });
  }
  patchAccount(account: string, body: PatchAccountReq) {
    return this.request(`/v1/accounts/${encodeURIComponent(account)}`, {
      method: 'PATCH',
      body,
      schema: AccountInfo,
    });
  }
  events(cursor: string | null) {
    return this.request('/v1/events', { schema: EventsRes, query: { cursor } });
  }
  createReminder(body: CreateReminderReq) {
    return this.request('/v1/reminders', { method: 'POST', body, schema: Reminder });
  }
  listReminders(q: { status?: ReminderStatus; account?: string | null }) {
    return this.request('/v1/reminders', {
      schema: RemindersRes,
      query: { status: q.status, account: q.account ?? undefined },
    });
  }
  patchReminder(id: string, status: ReminderStatus) {
    return this.request(`/v1/reminders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { status },
      schema: Reminder,
    });
  }
  deleteReminder(id: string) {
    return this.request<void>(`/v1/reminders/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}
