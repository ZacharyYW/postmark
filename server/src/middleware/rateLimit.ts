/**
 * In-memory token bucket keyed by an arbitrary string (IP hash or user id).
 * Single-instance only; see PLAN-3 F22.
 */
export class TokenBucketLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Returns true if the request is allowed (and consumes a token). */
  take(key: string, now: number = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evict(now);
      b = { tokens: this.capacity, updated: now };
      this.buckets.set(key, b);
    } else {
      const elapsed = Math.max(0, now - b.updated) / 1000;
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
      b.updated = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Seconds until a token is available (for Retry-After). */
  retryAfter(key: string): number {
    const b = this.buckets.get(key);
    if (!b || b.tokens >= 1) return 0;
    return Math.ceil((1 - b.tokens) / this.refillPerSec);
  }

  private evict(now: number): void {
    // Drop buckets that would be full again (idle long enough); fall back to clearing oldest half.
    const fullAfterMs = (this.capacity / this.refillPerSec) * 1000;
    for (const [k, b] of this.buckets) {
      if (now - b.updated > fullAfterMs) this.buckets.delete(k);
    }
    if (this.buckets.size >= this.maxKeys) {
      const keys = [...this.buckets.keys()].slice(0, Math.floor(this.maxKeys / 2));
      for (const k of keys) this.buckets.delete(k);
    }
  }
}

export interface Limiters {
  publicByIp: TokenBucketLimiter;
  registerByIp: TokenBucketLimiter;
  apiByUser: TokenBucketLimiter;
}

export function defaultLimiters(): Limiters {
  return {
    publicByIp: new TokenBucketLimiter(60, 1),
    registerByIp: new TokenBucketLimiter(5, 5 / 60),
    apiByUser: new TokenBucketLimiter(120, 2),
  };
}
