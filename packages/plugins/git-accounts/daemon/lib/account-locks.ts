import type { GitAccountId } from '../../contract/index.ts';

/** One queue for connect, key creation, launch, revoke and disconnect. */
export class AccountLocks {
  readonly #tails = new Map<GitAccountId, Promise<unknown>>();
  run<T>(id: GitAccountId, work: () => Promise<T>): Promise<T> {
    const before = this.#tails.get(id) ?? Promise.resolve();
    const run = before.then(work, work);
    const tail = run.catch(() => undefined);
    this.#tails.set(id, tail);
    void tail.then(() => {
      if (this.#tails.get(id) === tail) this.#tails.delete(id);
    });
    return run;
  }
}
