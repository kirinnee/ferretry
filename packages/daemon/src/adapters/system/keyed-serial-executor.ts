import type { SerialExecutor } from '../../lib/index.ts';

/** Serializes work per key while allowing an exclusive rebuild barrier. */
export class KeyedSerialExecutor implements SerialExecutor {
  private readonly keyTails = new Map<string, Promise<void>>();
  private barrier: Promise<void> = Promise.resolve();

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

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const pending = [this.barrier, ...this.keyTails.values()];
    const result = Promise.all(pending.map(item => item.catch(() => undefined))).then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.barrier = settled;
    return await result;
  }
}
