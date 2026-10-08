import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DEFAULTS,
  CreateMessageReq,
  gmailThreadUrl,
  isInQuietHours,
  isTrackableHref,
  ListMessagesQuery,
  normalizeAccount,
  relativeTime,
  resolveSettings,
} from '../src';

describe('normalizeAccount', () => {
  it.each([
    ['Alice@Example.COM', 'alice@example.com'],
    ['  bob@work.io ', 'bob@work.io'],
    ['Bob Smith <Bob@Work.io>', 'bob@work.io'],
    ['not-an-email', null],
    ['', null],
    [null, null],
    ['a@b', null],
  ])('%s → %s', (input, out) => {
    expect(normalizeAccount(input)).toBe(out);
  });
});

describe('isTrackableHref', () => {
  const origin = 'https://track.postmark.test';
  it.each([
    ['https://example.com/a', true],
    ['http://example.com', true],
    ['mailto:a@b.com', false],
    ['tel:+123', false],
    ['#section', false],
    ['/relative', false],
    ['javascript:alert(1)', false],
    ['https://track.postmark.test/l/abc', false],
    ['ftp://files.example.com', false],
    ['', false],
    [null, false],
  ])('%s → %s', (href, out) => {
    expect(isTrackableHref(href, origin)).toBe(out);
  });
});

describe('resolveSettings precedence', () => {
  it('uses built-in defaults when nothing set', () => {
    expect(resolveSettings()).toEqual({ ...BUILTIN_DEFAULTS });
  });
  it('global overrides built-in', () => {
    expect(resolveSettings(null, { trackingDefault: false }).trackingDefault).toBe(false);
  });
  it('account overrides global', () => {
    const r = resolveSettings({ trackingDefault: true }, { trackingDefault: false });
    expect(r.trackingDefault).toBe(true);
  });
  it('account notificationsEnabled=false silences all types', () => {
    const r = resolveSettings({ notificationsEnabled: false }, { notifyClick: true });
    expect([r.notifyFirstOpen, r.notifyClick, r.notifyReminders]).toEqual([false, false, false]);
  });
  it('account notificationsEnabled=true overrides global off', () => {
    const r = resolveSettings({ notificationsEnabled: true }, { notifyClick: false });
    expect(r.notifyClick).toBe(true);
  });
  it('account quiet hours override global', () => {
    const r = resolveSettings(
      { quietHours: { start: '01:00', end: '02:00' } },
      { quietHours: { start: '22:00', end: '07:00' } },
    );
    expect(r.quietHours).toEqual({ start: '01:00', end: '02:00' });
  });
  it('ignores undefined global keys', () => {
    expect(resolveSettings(null, { trackingDefault: undefined }).trackingDefault).toBe(true);
  });
});

describe('isInQuietHours', () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
  it('handles same-day windows', () => {
    const q = { start: '09:00', end: '17:00' };
    expect(isInQuietHours(q, at(10))).toBe(true);
    expect(isInQuietHours(q, at(17))).toBe(false);
  });
  it('wraps midnight', () => {
    const q = { start: '22:00', end: '07:00' };
    expect(isInQuietHours(q, at(23))).toBe(true);
    expect(isInQuietHours(q, at(3))).toBe(true);
    expect(isInQuietHours(q, at(12))).toBe(false);
  });
  it('null is never quiet', () => expect(isInQuietHours(null, at(1))).toBe(false));
});

describe('schemas', () => {
  it('lower-cases sender account and recipients', () => {
    const r = CreateMessageReq.parse({
      senderAccount: 'Me@Work.COM',
      subject: 'Hi',
      recipients: ['You@X.com'],
      links: ['https://a.com'],
    });
    expect(r.senderAccount).toBe('me@work.com');
    expect(r.recipients).toEqual(['you@x.com']);
  });
  it('rejects non-http links', () => {
    expect(() =>
      CreateMessageReq.parse({
        senderAccount: 'a@b.com',
        subject: '',
        recipients: ['c@d.com'],
        links: ['javascript:alert(1)'],
      }),
    ).toThrow();
  });
  it('parses threadIds csv', () => {
    const q = ListMessagesQuery.parse({ threadIds: 'a1,b2, c3' });
    expect(q.threadIds).toEqual(['a1', 'b2', 'c3']);
    expect(q.limit).toBe(50);
  });
});

describe('urls/time', () => {
  it('builds Gmail deep link with authuser', () => {
    expect(gmailThreadUrl('18abc', 'me@work.com')).toBe(
      'https://mail.google.com/mail/?authuser=me%40work.com#all/18abc',
    );
  });
  it('relative time', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(relativeTime('2026-01-01T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-01-01T11:55:00Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-01-01T09:00:00Z', now)).toBe('3 h ago');
  });
});
