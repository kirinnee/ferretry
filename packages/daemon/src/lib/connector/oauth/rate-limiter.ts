import type { ConnectorClock } from './model.ts';
import { OAuthError } from './model.ts';

/** A fixed window admission budget; only known client/grant ids should be used as dynamic keys. */
export class ConnectorRateLimiter {
  private readonly windows = new Map<string, { until: number; count: number }>();
  constructor(private readonly clock: ConnectorClock) {}

  take(key: string, limit: number, durationMs = 60_000): void {
    const now = this.clock.now();
    for (const [id, window] of this.windows) if (window.until <= now) this.windows.delete(id);
    const window = this.windows.get(key) ?? { until: now + durationMs, count: 0 };
    if (window.count >= limit) {
      throw new OAuthError(
        'slow_down',
        'Too many requests. Please try again later.',
        429,
        Math.max(1, Math.ceil((window.until - now) / 1000)),
      );
    }
    this.windows.set(key, { ...window, count: window.count + 1 });
  }
}
