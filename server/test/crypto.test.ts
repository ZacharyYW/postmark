import { describe, expect, it } from 'vitest';
import { hashIp, newId, signShort, verifyShort } from '../src/lib/crypto';

describe('crypto helpers', () => {
  it('ids are 21 url-safe chars and unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });
  it('hashIp is salted and does not contain the IP', () => {
    const a = hashIp('203.0.113.7', 'salt-a');
    expect(a).not.toContain('203');
    expect(a).not.toBe(hashIp('203.0.113.7', 'salt-b'));
    expect(a).toHaveLength(32);
  });
  it('short signatures verify only for the same value', () => {
    const s = signShort('secret', 'px|a@b.com');
    expect(verifyShort('secret', 'px|a@b.com', s)).toBe(true);
    expect(verifyShort('secret', 'px|c@d.com', s)).toBe(false);
    expect(verifyShort('secret', 'px|a@b.com', undefined)).toBe(false);
    expect(verifyShort('secret', 'px|a@b.com', 'short')).toBe(false);
  });
});
