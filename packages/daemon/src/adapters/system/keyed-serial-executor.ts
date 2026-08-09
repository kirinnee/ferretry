import type { SerialExecutor } from '../../lib/index.ts';

/** Serializes work per key while allowing an exclusive rebuild barrier. */
export class KeyedSerialExecutor implements SerialExecutor {
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
}
