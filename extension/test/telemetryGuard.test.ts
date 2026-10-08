import { describe, expect, it } from 'vitest';
import { blockedLog, installTelemetryGuard, isBlockedUrl } from '../src/gmail/telemetryGuard';

describe('InboxSDK telemetry guard', () => {
  it.each([
    ['https://api.inboxsdk.com/api/v2/errors', true],
    ['https://api.inboxsdk.com/api/v2/events/oauth', true],
    ['https://pubsub.googleapis.com/v1/projects/mailfoogae/topics/events:publish?key=x', true],
    ['https://mail.google.com/sync/u/0/i/s', false],
    ['https://people-pa.clients6.google.com/v2/people', false],
    ['http://localhost:8787/v1/messages', false],
    ['/relative/path', false],
  ])('%s → %s', (url, blocked) => expect(isBlockedUrl(url)).toBe(blocked));

  it('blocked XHRs are answered locally with 200 (no network, no error noise)', async () => {
    installTelemetryGuard(window as Window & typeof globalThis);
    const xhr = new XMLHttpRequest();
    const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      xhr.onerror = () => reject(new Error('should not error'));
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.open('POST', 'https://api.inboxsdk.com/api/v2/errors', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send('{"error":"x"}');
    });
    expect(result).toEqual({ status: 200, text: '{}' });
    expect(blockedLog).toContain('https://api.inboxsdk.com/api/v2/errors');

    const token = await new Promise<string>((resolve) => {
      const x = new XMLHttpRequest();
      x.onload = () => resolve(x.responseText);
      x.open('GET', 'https://api.inboxsdk.com/api/v2/events/oauth', true);
      x.send();
    });
    // InboxSDK refreshes the token if it expires within 10 minutes; ours lasts a year.
    expect(JSON.parse(token).expirationDate).toBeGreaterThan(Date.now() + 86_400_000);

    const r = await fetch('https://pubsub.googleapis.com/v1/projects/x');
    expect(r.status).toBe(200);
  });
});
