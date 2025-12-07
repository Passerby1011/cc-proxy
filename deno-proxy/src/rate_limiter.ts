import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";

export class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  async acquire(): Promise<void> {
    if (this.limit <= 0) {
      return;
    }
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((ts) => now - ts < this.windowMs);
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = Math.max(0, this.windowMs - (now - this.timestamps[0]));
      await delay(waitMs || 1);
    }
  }
}
