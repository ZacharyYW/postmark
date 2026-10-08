import { z } from 'zod';
import { QuietHoursSchema, type AccountSettings, type QuietHours } from './schemas';

export const GlobalSettingsSchema = z.object({
  trackingDefault: z.boolean(),
  notifyFirstOpen: z.boolean(),
  notifyClick: z.boolean(),
  notifyReminders: z.boolean(),
  disclosureFooter: z.boolean(),
  quietHours: QuietHoursSchema.nullable(),
});
export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

export const BUILTIN_DEFAULTS: GlobalSettings = Object.freeze({
  trackingDefault: true,
  notifyFirstOpen: true,
  notifyClick: true,
  notifyReminders: true,
  disclosureFooter: false,
  quietHours: null,
});

export interface ResolvedSettings {
  trackingDefault: boolean;
  notifyFirstOpen: boolean;
  notifyClick: boolean;
  notifyReminders: boolean;
  disclosureFooter: boolean;
  quietHours: QuietHours | null;
}

/**
 * Precedence: per-account setting → global setting → built-in default.
 * `notificationsEnabled === false` on an account silences every notification type for it.
 */
export function resolveSettings(
  account?: AccountSettings | null,
  global?: Partial<GlobalSettings> | null,
): ResolvedSettings {
  const g = { ...BUILTIN_DEFAULTS, ...stripUndefined(global ?? {}) };
  const a = account ?? {};
  const notifOff = a.notificationsEnabled === false;
  const notifForcedOn = a.notificationsEnabled === true;
  return {
    trackingDefault: a.trackingDefault ?? g.trackingDefault,
    notifyFirstOpen: notifOff ? false : notifForcedOn ? true : g.notifyFirstOpen,
    notifyClick: notifOff ? false : notifForcedOn ? true : g.notifyClick,
    notifyReminders: notifOff ? false : notifForcedOn ? true : g.notifyReminders,
    disclosureFooter: g.disclosureFooter,
    quietHours: a.quietHours !== undefined ? a.quietHours : g.quietHours,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Whether `now` (local time) falls inside quiet hours. Wraps midnight when start > end. */
export function isInQuietHours(q: QuietHours | null, now: Date): boolean {
  if (!q) return false;
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
