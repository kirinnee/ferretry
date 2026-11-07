/**
 * ONE TURN AT A TIME PER SESSION, for everything that touches a session's terminals' keyboards: raising a
 * request (observing the terminal and reserving it), an agent's keystrokes, closing a terminal, and the one
 * secure write. Without it a check made a moment ago says nothing about the moment of the write.
 */
export class SessionLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `work` after every earlier call for `key` has settled, whether it threw or not. */
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    }
  }
}
