/** Runs work one at a time per key; work under different keys runs together. */
export interface SerialRun {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/**
 * A promise chain per key: pure, with no timer. The work of one key never overlaps, a rejection is the caller's and
 * does not break the chain, and a key with nothing waiting is forgotten.
 */
export class KeyedSerial implements SerialRun {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return run;
  }
}
