import type { YieldingSerialExecutor } from '../../lib/index.ts';

/**
 * How many times queued yielding exclusive work steps aside for keyed work before it queues fairly.
 *
 * Each step waits for real work to settle, so this is not a spin. It bounds the yield: a fleet so busy
 * that a keyed tail is always open would otherwise never let its backlog proof run at all.
 */
export const EXCLUSIVE_YIELD_LIMIT = 16;

/** Serializes work per key while allowing an exclusive rebuild barrier. */
export class KeyedSerialExecutor implements YieldingSerialExecutor {
  private readonly keyTails = new Map<string, Promise<void>>();
  private barrier: Promise<void> = Promise.resolve();
  private exclusivePending = 0;

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.keyTails.get(key) ?? Promise.resolve();
    const barrier = this.barrier;
    const result = Promise.all([previous.catch(() => undefined), barrier.catch(() => undefined)]).then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.keyTails.set(key, settled);
    try {
      return await result;
    } finally {
      if (this.keyTails.get(key) === settled) this.keyTails.delete(key);
    }
  }

  /**
   * Runs observation work only when the key is idle now.
   *
   * Session reads and monitor projection must never queue behind a terminal drive: a slow form
   * would otherwise stall the whole roster. The check and tail registration are synchronous on the
   * JavaScript turn, so two callers cannot both observe an idle key before one registers its work.
   */
  async runIfIdle<T>(key: string, work: () => Promise<T>): Promise<T | undefined> {
    if (this.keyTails.has(key) || this.exclusivePending > 0) return undefined;
    return await this.run(key, work);
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    this.exclusivePending += 1;
    try {
      const pending = [this.barrier, ...this.keyTails.values()];
      const result = Promise.all(pending.map(item => item.catch(() => undefined))).then(work);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      this.barrier = settled;
      return await result;
    } finally {
      this.exclusivePending -= 1;
    }
  }

  /**
   * Exclusive work that lets keyed work queued after it go first.
   *
   * WHY. `runExclusive` takes the barrier the moment it is CALLED, so every keyed call after it waits
   * for it — and for every exclusive pass queued before it. A live feed's backlog proof is a full survey
   * of the fleet; with dozens of feeds reconnecting, session writes (a launch, a resume, a signal) sat
   * behind a queue of those passes for minutes.
   *
   * HOW. While it waits this holds no barrier, so keyed work keeps the barrier it saw. It waits for the
   * barrier and the keyed tails it can see; once they have settled, and nothing new arrived meanwhile, it
   * claims the barrier through `runExclusive` on the same synchronous turn, so from that instant it is
   * exactly as exclusive as `runExclusive`. If new keyed work did arrive it waits again, at most
   * {@link EXCLUSIVE_YIELD_LIMIT} times, and then queues like `runExclusive` so it cannot starve.
   *
   * It does not count as pending while it only waits: `runIfIdle` observation keeps running until the
   * pass actually claims the barrier.
   */
  async runExclusiveYielding<T>(work: () => Promise<T>): Promise<T> {
    for (let step = 0; step < EXCLUSIVE_YIELD_LIMIT; step += 1) {
      const barrier = this.barrier;
      const tails = new Set(this.keyTails.values());
      await Promise.all([barrier, ...tails]);
      if (this.barrier === barrier && [...this.keyTails.values()].every(tail => tails.has(tail))) break;
    }
    return await this.runExclusive(work);
  }
}
