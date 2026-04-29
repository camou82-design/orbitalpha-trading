export class LogDeduper {
  private cache = new Map<string, number>();
  private maxEntries: number;
  private ttlMs: number;

  constructor(maxEntries = 3000, ttlMs = 60000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /**
   * @returns true if the log should be emitted (not a duplicate), false otherwise.
   */
  shouldLog(key: string): boolean {
    const now = Date.now();
    const lastLogged = this.cache.get(key) || 0;

    if (now - lastLogged < this.ttlMs) {
      return false;
    }

    // Periodic cleanup or capacity management
    if (this.cache.size >= this.maxEntries) {
      this.cleanup(now);
    }

    // Safety fallback: if cleanup didn't free enough space, prune oldest half
    if (this.cache.size >= this.maxEntries) {
      const keys = Array.from(this.cache.keys());
      // We don't necessarily need to sort by time, just pruning some keys is enough for safety
      // but let's prune the first half (which are usually the oldest in Map insertion order)
      const toDelete = Math.floor(this.maxEntries / 2);
      for (let i = 0; i < toDelete; i++) {
        const k = keys[i];
        if (k !== undefined) {
          this.cache.delete(k);
        }
      }
    }

    this.cache.set(key, now);
    return true;
  }

  private cleanup(now: number) {
    for (const [k, v] of this.cache.entries()) {
      if (now - v >= this.ttlMs) {
        this.cache.delete(k);
      }
    }
  }
}
