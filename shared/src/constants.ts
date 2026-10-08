export const UA_CLASSES = ['gmail_proxy', 'apple_mpp', 'sender', 'bot', 'other'] as const;
export type UaClass = (typeof UA_CLASSES)[number];

export const EVENT_TYPES = ['open', 'click'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const REMINDER_CONDITIONS = ['no_open', 'no_reply', 'always'] as const;
export type ReminderCondition = (typeof REMINDER_CONDITIONS)[number];

export const REMINDER_STATUSES = ['pending', 'fired', 'satisfied', 'cancelled'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const MESSAGE_STATUSES = ['sent', 'auto_loaded', 'opened', 'clicked'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Classes that count toward "opens" and trigger notifications. */
export const COUNTED_OPEN_CLASSES: readonly UaClass[] = ['gmail_proxy', 'other'];
/** Classes that count toward clicks. */
export const COUNTED_CLICK_CLASSES: readonly UaClass[] = ['gmail_proxy', 'other'];

export const TIMING = {
  /** Opens within this long after send are treated as the sender's own (compose preview, Sent view). */
  SELF_OPEN_GRACE_MS: 10_000,
  /** A self-view beacon suppresses Gmail-proxy opens within ± this window. */
  SELF_VIEW_WINDOW_MS: 20_000,
  /** Identical (ip_hash, ua_class) events within this window collapse into one. */
  DEDUPE_WINDOW_MS: 30_000,
  /** Apple-Mail-shaped fetches this soon after send are treated as MPP prefetch. */
  MPP_PREFETCH_WINDOW_MS: 120_000,
  /** Clicks this soon after send are treated as link scanners. */
  CLICK_SCANNER_WINDOW_MS: 10_000,
  /** Events younger than this are withheld from /v1/events so self-view reclassification can land. */
  EVENT_SETTLE_MS: 20_000,
  /** Hard cap for the compose-time server call. */
  PRESEND_TIMEOUT_MS: 3_000,
} as const;

export const ID_PATTERN = /^[A-Za-z0-9_-]{21}$/;

export const LIMITS = {
  SUBJECT_MAX: 998,
  RECIPIENTS_MAX: 100,
  LINKS_MAX: 200,
  URL_MAX: 4096,
  LIST_DEFAULT: 50,
  LIST_MAX: 200,
  EVENTS_DEFAULT: 200,
  EVENTS_MAX: 500,
  THREAD_IDS_MAX: 100,
} as const;
