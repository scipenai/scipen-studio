export class SessionRateLimiter {
  constructor(maxTokens = 60, refillRatePerSecond = 1) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRatePerSecond;
    this.buckets = new Map();
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.lastRefill > 5 * 60 * 1000) {
          this.buckets.delete(key);
        }
      }
    }, 5 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  consume(sessionId) {
    const now = Date.now();
    let bucket = this.buckets.get(sessionId);
    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: now };
      this.buckets.set(sessionId, bucket);
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  dispose() {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }
}
