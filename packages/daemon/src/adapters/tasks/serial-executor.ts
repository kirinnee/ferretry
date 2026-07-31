/**
 * Serializes work per key. The task store runs its whole read-decide-rewrite transaction inside one
 * of these, so a graph read, a global id allocation, the reducer call, and the atomic file rewrite
 * are a single critical section rather than four racy steps.
 */
export interface SerialExecutor {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/**
 * A per-key promise chain. Two properties matter and are both tested:
 *
 * - a rejected step never poisons the chain — the tail is a *settled* promise, so the next caller
 *   runs whatever happened before it;
 * - a key is released once its chain drains, so a long-lived daemon does not accumulate one entry
 *   per session it has ever touched.
 */
export class KeyedSerialExecutor implements SerialExecutor {
  private readonly chains = new Map<string, Promise<void>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return result;
  }

  /** Number of keys still holding a queue. Zero once every scheduled transaction has drained. */
  pendingKeys(): number {
    return this.chains.size;
  }
}
