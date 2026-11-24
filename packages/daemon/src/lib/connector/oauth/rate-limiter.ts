import type { ConnectorClock } from './model.ts';
import { OAuthError } from './model.ts';

/**
 * A fixed-window admission budget in memory. Keys name a source address, a known client id or a fixed bucket, so
 * the map is bounded: at `maxKeys` the oldest window is dropped for a new one (a flood from many sources forgets
 * old counters rather than growing without limit), and expired windows are swept at most once a second.
 */
export class ConnectorRateLimiter {
  private readonly windows = new Map<string, { until: number; count: number }>();
  private nextSweep = 0;
  constructor(
    private readonly clock: ConnectorClock,
    private readonly maxKeys = 10_000,
  ) {}

  /** Refuses (429) when the key's window is full; charges nothing. */
  check(key: string, limit: number): void {
    const now = this.clock.now();
    const window = this.live(key, now);
    if (window && window.count >= limit) {
      throw new OAuthError(
        'slow_down',
        'Too many requests. Please try again later.',
        429,
        Math.max(1, Math.ceil((window.until - now) / 1000)),
      );
    }
  }

  /** Charges one unit without refusing — for a budget that only failures (or only successes) spend. */
  record(key: string, durationMs = 60_000): void {
    const now = this.clock.now();
    const window = this.live(key, now);
    if (window) {
      window.count += 1;
      return;
    }
    const oldest = this.windows.keys().next().value;
    if (this.windows.size >= this.maxKeys && !this.windows.has(key) && oldest !== undefined)
      this.windows.delete(oldest);
    this.windows.set(key, { until: now + durationMs, count: 1 });
  }

  take(key: string, limit: number, durationMs = 60_000): void {
    this.check(key, limit);
    this.record(key, durationMs);
  }

  private live(key: string, now: number): { until: number; count: number } | undefined {
    if (now >= this.nextSweep) {
      for (const [id, window] of this.windows) if (window.until <= now) this.windows.delete(id);
      this.nextSweep = now + 1000;
    }
    const window = this.windows.get(key);
    return window && window.until > now ? window : undefined;
  }
}
