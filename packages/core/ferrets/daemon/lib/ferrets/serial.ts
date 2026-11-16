/** Copied keyed lifecycle queue from today's adapters/storage/keyed-serial-executor.ts. */
export class KeyedSerialExecutor {
  private readonly keyTails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.keyTails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
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
}
