import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from '../src/middleware/rateLimit';

describe('TokenBucketLimiter', () => {
  it('allows up to capacity then refills over time', () => {
    const l = new TokenBucketLimiter(3, 1);
    const t = 1_000_000;
    expect([l.take('k', t), l.take('k', t), l.take('k', t), l.take('k', t)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(l.retryAfter('k')).toBeGreaterThan(0);
    expect(l.take('k', t + 1000)).toBe(true);
    expect(l.take('k', t + 1000)).toBe(false);
  });
  it('keys are independent', () => {
    const l = new TokenBucketLimiter(1, 1);
    expect(l.take('a', 0)).toBe(true);
    expect(l.take('b', 0)).toBe(true);
    expect(l.take('a', 0)).toBe(false);
  });
  it('evicts when exceeding maxKeys', () => {
    const l = new TokenBucketLimiter(1, 1, 10);
    for (let i = 0; i < 25; i++) l.take(`k${i}`, i);
    expect(l.take('fresh', 100)).toBe(true);
  });
});
