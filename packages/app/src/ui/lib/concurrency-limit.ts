/**
 * At most `limit` tasks run at once; the rest start in arrival order as earlier ones settle.
 *
 * For a surface that has many small reads to make of one daemon. Firing them all in one tick does not
 * make them arrive sooner — the daemon runs a session's requests sixteen at a time and every other panel
 * shares that session — it only makes everything else on the page wait behind them.
 */
export class ConcurrencyLimit {
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('a concurrency limit is a positive integer');
  }

  /** Run `task` once a slot is free. A task that throws frees its slot exactly as one that returns. */
  async run<Value>(task: () => Promise<Value>): Promise<Value> {
    if (this.#running >= this.limit) await new Promise<void>(start => this.#waiting.push(start));
    else this.#running += 1;
    try {
      return await task();
    } finally {
      // The slot passes straight to the next waiter, so `#running` never dips and lets a newcomer jump the queue.
      const next = this.#waiting.shift();
      if (next === undefined) this.#running -= 1;
      else next();
    }
  }
}
