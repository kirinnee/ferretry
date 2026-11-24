/**
 * A sliding-window rate limiter, in memory, with an injectable clock.
 *
 * The connector's budget (docs/mcp-connector.md "Rate limits") is per GRANT: 60 tool calls a minute, of which
 * write tools 10. A grant's limiter dying with the process is fine — a restart drops every pending sign-in
 * too, and the cap exists to bound a runaway assistant loop, not to be an audit.
 */

export type RateDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

export class SlidingWindowLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly now: () => number,
    private readonly windowMs = 60_000,
  ) {}

  /** Counts one hit against `key` unless it would pass `limit` in the window. Over the limit counts nothing. */
  take(key: string, limit: number): RateDecision {
    const current = this.now();
    const live = (this.#hits.get(key) ?? []).filter(at => at > current - this.windowMs);
    if (live.length >= limit) {
      this.#hits.set(key, live);
      const oldest = live[0] ?? current;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - current) / 1000)) };
    }
    live.push(current);
    this.#hits.set(key, live);
    this.#sweep(current);
    return { ok: true };
  }

  /** Whether `limit` more hits would be refused, without counting any. */
  peek(key: string, limit: number): RateDecision {
    const current = this.now();
    const live = (this.#hits.get(key) ?? []).filter(at => at > current - this.windowMs);
    if (live.length < limit) return { ok: true };
    const oldest = live[0] ?? current;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - current) / 1000)) };
  }

  /** Forgets keys with nothing in the window, so a revoked grant's entry does not live forever. */
  #sweep(current: number): void {
    if (this.#hits.size < 256) return;
    for (const [key, hits] of this.#hits) {
      if (hits.every(at => at <= current - this.windowMs)) this.#hits.delete(key);
    }
  }
}
