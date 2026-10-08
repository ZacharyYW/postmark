import { describe, expect, it } from 'vitest';
import {
  BLOCKED_STATUS,
  blockedLog,
  installTelemetryGuard,
  isBlockedUrl,
} from '../src/gmail/telemetryGuard';

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

  it('blocked XHRs fail locally with status 490 and never hit the network', async () => {
    installTelemetryGuard(window as Window & typeof globalThis);
    const xhr = new XMLHttpRequest();
    const result = await new Promise<number>((resolve) => {
      xhr.onerror = () => resolve(xhr.status);
      xhr.onload = () => resolve(-1);
      xhr.open('POST', 'https://api.inboxsdk.com/api/v2/errors', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send('{"error":"x"}');
    });
    expect(result).toBe(BLOCKED_STATUS);
    expect(blockedLog).toContain('https://api.inboxsdk.com/api/v2/errors');
    await expect(fetch('https://pubsub.googleapis.com/v1/projects/x')).rejects.toThrow(
      /privacy guard/,
    );
  });
});
