import { z } from 'zod';
import {
  EVENT_TYPES,
  LIMITS,
  MESSAGE_STATUSES,
  REMINDER_CONDITIONS,
  REMINDER_STATUSES,
  UA_CLASSES,
} from './constants';
import { normalizeAccount } from './accounts';
import { isHttpUrl } from './urls';

// ---------- primitives ----------

export const Email = z
  .string()
  .max(320)
  .transform((v, ctx) => {
    const n = normalizeAccount(v);
    if (n === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid email address' });
      return z.NEVER;
    }
    return n;
  });

/** A Gmail sender account (lower-cased email). */
export const Account = Email;

export const HttpUrl = z
  .string()
  .max(LIMITS.URL_MAX)
  .refine(isHttpUrl, { message: 'Only absolute http(s) URLs are allowed' });

export const IsoDate = z.string().datetime({ offset: true });
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const UaClassSchema = z.enum(UA_CLASSES);
export const EventTypeSchema = z.enum(EVENT_TYPES);
export const ReminderConditionSchema = z.enum(REMINDER_CONDITIONS);
export const ReminderStatusSchema = z.enum(REMINDER_STATUSES);
export const MessageStatusSchema = z.enum(MESSAGE_STATUSES);

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
export const QuietHoursSchema = z.object({ start: HHMM, end: HHMM });
export type QuietHours = z.infer<typeof QuietHoursSchema>;

// ---------- auth ----------

export const RegisterReq = z.object({ email: Email });
export type RegisterReq = z.infer<typeof RegisterReq>;
export const RegisterRes = z.object({ token: z.string(), userId: z.string(), email: z.string() });
export type RegisterRes = z.infer<typeof RegisterRes>;

export const MeRes = z.object({ userId: z.string(), email: z.string(), createdAt: IsoDate });
export type MeRes = z.infer<typeof MeRes>;

// ---------- messages ----------

export const CreateMessageReq = z.object({
  senderAccount: Account,
  subject: z.string().max(LIMITS.SUBJECT_MAX),
  recipients: z.array(Email).min(1).max(LIMITS.RECIPIENTS_MAX),
  links: z.array(HttpUrl).max(LIMITS.LINKS_MAX),
  clientRequestId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w.@:+-]+$/)
    .optional(),
});
export type CreateMessageReq = z.input<typeof CreateMessageReq>;

export const RewrittenLink = z.object({
  original: z.string(),
  trackedUrl: z.string(),
  linkId: z.string(),
});
export type RewrittenLink = z.infer<typeof RewrittenLink>;

export const CreateMessageRes = z.object({
  messageId: z.string(),
  pixelId: z.string(),
  pixelUrl: z.string(),
  rewrittenLinks: z.array(RewrittenLink),
});
export type CreateMessageRes = z.infer<typeof CreateMessageRes>;

export const BindMessageReq = z
  .object({
    gmailThreadId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w-]+$/)
      .optional(),
    gmailMessageId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w-]+$/)
      .optional(),
    repliedAt: IsoDate.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field is required',
  });
export type BindMessageReq = z.infer<typeof BindMessageReq>;

export const OpenStats = z.object({
  total: z.number().int(),
  unique: z.number().int(),
  autoLoaded: z.number().int(),
  first: IsoDate.nullable(),
  last: IsoDate.nullable(),
});
export type OpenStats = z.infer<typeof OpenStats>;

export const LinkStats = z.object({
  id: z.string(),
  originalUrl: z.string(),
  position: z.number().int(),
  clicks: z.number().int(),
  lastClick: IsoDate.nullable(),
});
export type LinkStats = z.infer<typeof LinkStats>;

export const MessageSummary = z.object({
  id: z.string(),
  senderAccount: z.string(),
  gmailThreadId: z.string().nullable(),
  gmailMessageId: z.string().nullable(),
  subject: z.string(),
  recipients: z.array(z.string()),
  sentAt: IsoDate,
  trackingEnabled: z.boolean(),
  repliedAt: IsoDate.nullable(),
  opens: OpenStats,
  clicks: z.object({ total: z.number().int(), last: IsoDate.nullable() }),
  links: z.array(LinkStats),
  lastEvent: z
    .object({ type: EventTypeSchema, occurredAt: IsoDate, uaClass: UaClassSchema })
    .nullable(),
  status: MessageStatusSchema,
});
export type MessageSummary = z.infer<typeof MessageSummary>;

const csv = (max: number) =>
  z
    .string()
    .max(4000)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[\w-]{1,64}$/)).max(max));

export const ListMessagesQuery = z.object({
  since: IsoDate.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.LIST_MAX).default(LIMITS.LIST_DEFAULT),
  account: Account.optional(),
  /** Comma-separated sender accounts (a tab's primary account plus its "Send as" aliases). */
  accounts: z
    .string()
    .max(4000)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(Account).max(50))
    .optional(),
  threadIds: csv(LIMITS.THREAD_IDS_MAX).optional(),
  q: z.string().max(200).optional(),
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

export const ListMessagesRes = z.object({ messages: z.array(MessageSummary) });
export type ListMessagesRes = z.infer<typeof ListMessagesRes>;

export const SelfViewReq = z.object({ account: Account });
export type SelfViewReq = z.infer<typeof SelfViewReq>;

// ---------- events ----------

export const TrackingEvent = z.object({
  id: z.number().int(),
  messageId: z.string(),
  linkId: z.string().nullable(),
  linkUrl: z.string().nullable(),
  type: EventTypeSchema,
  occurredAt: IsoDate,
  uaClass: UaClassSchema,
  isFirst: z.boolean(),
  senderAccount: z.string(),
  subject: z.string(),
  recipients: z.array(z.string()),
  gmailThreadId: z.string().nullable(),
});
export type TrackingEvent = z.infer<typeof TrackingEvent>;

export const EventsQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  since: IsoDate.optional(),
  account: Account.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.EVENTS_MAX).default(LIMITS.EVENTS_DEFAULT),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

export const EventsRes = z.object({ events: z.array(TrackingEvent), cursor: z.string() });
export type EventsRes = z.infer<typeof EventsRes>;

export const MessageEventsRes = z.object({ events: z.array(TrackingEvent) });
export type MessageEventsRes = z.infer<typeof MessageEventsRes>;

// ---------- accounts ----------

export const AccountSettingsSchema = z.object({
  trackingDefault: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
  quietHours: QuietHoursSchema.optional(),
});
export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

/** PATCH body: `null` on a key clears the per-account override (falls back to global). */
export const PatchAccountReq = z
  .object({
    trackingDefault: z.boolean().nullable().optional(),
    notificationsEnabled: z.boolean().nullable().optional(),
    quietHours: QuietHoursSchema.nullable().optional(),
  })
  .strict();
export type PatchAccountReq = z.infer<typeof PatchAccountReq>;

export const AccountInfo = z.object({
  account: z.string(),
  messageCount: z.number().int(),
  lastSentAt: IsoDate.nullable(),
  settings: AccountSettingsSchema,
});
export type AccountInfo = z.infer<typeof AccountInfo>;

export const AccountsRes = z.object({ accounts: z.array(AccountInfo) });
export type AccountsRes = z.infer<typeof AccountsRes>;

// ---------- reminders ----------

export const CreateReminderReq = z.object({
  messageId: Id,
  remindAt: IsoDate,
  condition: ReminderConditionSchema,
});
export type CreateReminderReq = z.infer<typeof CreateReminderReq>;

export const PatchReminderReq = z.object({ status: ReminderStatusSchema });
export type PatchReminderReq = z.infer<typeof PatchReminderReq>;

export const Reminder = z.object({
  id: z.string(),
  messageId: z.string(),
  remindAt: IsoDate,
  condition: ReminderConditionSchema,
  status: ReminderStatusSchema,
  createdAt: IsoDate,
  subject: z.string(),
  recipients: z.array(z.string()),
  senderAccount: z.string(),
  gmailThreadId: z.string().nullable(),
});
export type Reminder = z.infer<typeof Reminder>;

export const RemindersQuery = z.object({
  status: ReminderStatusSchema.optional(),
  account: Account.optional(),
});
export type RemindersQuery = z.infer<typeof RemindersQuery>;

export const RemindersRes = z.object({ reminders: z.array(Reminder) });
export type RemindersRes = z.infer<typeof RemindersRes>;

// ---------- errors ----------

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
