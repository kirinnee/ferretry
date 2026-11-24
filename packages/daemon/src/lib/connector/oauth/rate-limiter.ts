import type { ConnectorClock } from './model.ts';
import { OAuthError } from './model.ts';

interface Window {
  until: number;
  count: number;
}

/**
 * Which budget a key belongs to. A `source` key names one requester's address, so a flood can mint any number of
 * them and they are bounded. A `fixed` key is one of a small closed set the daemon itself names (the global
 * ceilings and one per authenticated client), so it is never evicted: whatever a flood does to the source keys, a
 * global ceiling keeps counting.
 */
export type RateScope = 'source' | 'fixed';

/**
 * A fixed-window admission budget in memory. The per-source keys are bounded: at `maxKeys` the oldest SOURCE window
 * is dropped for a new one (a flood from many sources forgets old per-source counters rather than growing without
 * limit), and expired windows are swept at most once a second. Fixed keys live in their own map and are never
 * dropped for a source key, so filling the source map cannot reset a global ceiling.
 */
export class ConnectorRateLimiter {
  private readonly sources = new Map<string, Window>();
  private readonly fixed = new Map<string, Window>();
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
  record(key: string, durationMs = 60_000, scope: RateScope = 'fixed'): void {
    const now = this.clock.now();
    const window = this.live(key, now);
    if (window) {
      window.count += 1;
      return;
    }
    if (scope === 'fixed') {
      this.fixed.set(key, { until: now + durationMs, count: 1 });
      return;
    }
    const oldest = this.sources.keys().next().value;
    if (this.sources.size >= this.maxKeys && oldest !== undefined) this.sources.delete(oldest);
    this.sources.set(key, { until: now + durationMs, count: 1 });
  }

  take(key: string, limit: number, durationMs = 60_000, scope: RateScope = 'fixed'): void {
    this.check(key, limit);
    this.record(key, durationMs, scope);
  }

  private live(key: string, now: number): Window | undefined {
    if (now >= this.nextSweep) {
      for (const windows of [this.sources, this.fixed])
        for (const [id, window] of windows) if (window.until <= now) windows.delete(id);
      this.nextSweep = now + 1000;
    }
    const window = this.sources.get(key) ?? this.fixed.get(key);
    return window && window.until > now ? window : undefined;
  }
}
