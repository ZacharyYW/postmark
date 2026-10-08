import { describe, expect, it } from 'vitest';
import type { TrackingEvent } from '@postmark/shared';
import { attribution, buildActivity, describeEvent } from '../src/ui/activity';

const ev = (o: Partial<TrackingEvent>): TrackingEvent => ({
  id: 1,
  messageId: 'm',
  linkId: null,
  linkUrl: null,
  type: 'open',
  occurredAt: '2026-01-01T10:00:00Z',
  uaClass: 'other',
  isFirst: false,
  senderAccount: 'a@x.com',
  subject: 's',
  recipients: [],
  gmailThreadId: null,
  ...o,
});

describe('activity labels', () => {
  it.each([
    [ev({ uaClass: 'gmail_proxy' }), 'Opened (in Gmail)', false],
    [ev({ uaClass: 'other' }), 'Opened', false],
    [ev({ uaClass: 'apple_mpp' }), 'Possibly auto-loaded (Apple Mail privacy)', true],
    [ev({ uaClass: 'bot' }), 'Fetched by a security scanner', true],
    [ev({ uaClass: 'sender' }), 'Your own view', true],
    [
      ev({ type: 'click', linkUrl: 'https://docs.example.com/x' }),
      'Clicked docs.example.com/x',
      false,
    ],
    [
      ev({ type: 'click', uaClass: 'bot', linkUrl: 'https://a.com' }),
      'Link checked by a security scanner: a.com',
      true,
    ],
    [ev({ type: 'click', uaClass: 'sender', linkUrl: 'https://a.com' }), 'You clicked a.com', true],
  ])('%#', (e, text, ignored) => {
    const d = describeEvent(e);
    expect(d.text).toBe(text);
    expect(d.ignored).toBe(ignored);
  });

  it('shortUrl keeps links on the same site apart', async () => {
    const { shortUrl } = await import('../src/ui/format');
    expect(shortUrl('https://www.example.com/pricing/')).toBe('example.com/pricing');
    expect(shortUrl('https://example.com/')).toBe('example.com');
    expect(
      shortUrl('https://example.com/a/very/long/path/that/keeps/going/and/going'),
    ).toHaveLength(40);
    expect(shortUrl('not a url')).toBe('not a url');
  });

  it('sorts newest first', () => {
    const items = buildActivity([
      ev({ id: 1, occurredAt: '2026-01-01T10:00:00Z' }),
      ev({ id: 2, occurredAt: '2026-01-01T12:00:00Z' }),
    ]);
    expect(items.map((i) => i.id)).toEqual([2, 1]);
  });

  it('attribution is honest for single vs multiple recipients', () => {
    expect(attribution(['dana@x.com'])).toMatch(/most likely theirs/);
    expect(attribution(['a@x.com', 'b@x.com', 'c@x.com'])).toMatch(
      /can’t be attributed to a specific person/,
    );
  });
});
