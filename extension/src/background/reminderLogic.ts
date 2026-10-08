import type { MessageSummary, ReminderCondition } from '@postmark/shared';

/** Whether a due reminder should still notify (its condition is unmet). */
export function reminderStillUnmet(condition: ReminderCondition, m: MessageSummary): boolean {
  switch (condition) {
    case 'no_open':
      return m.opens.total === 0 && m.clicks.total === 0;
    case 'no_reply':
      return m.repliedAt === null;
    case 'always':
      return true;
  }
}

export function reminderText(condition: ReminderCondition, m: MessageSummary): string {
  const who = m.recipients[0] ?? 'your recipient';
  switch (condition) {
    case 'no_open':
      return `No open detected yet from ${who}. Time to follow up?`;
    case 'no_reply':
      return `No reply detected from ${who}. Time to follow up?`;
    case 'always':
      return `Follow-up reminder for your email to ${who}.`;
  }
}

export const REMINDER_ALARM_PREFIX = 'pm-rem:';
export const POLL_ALARM = 'pm-poll';
