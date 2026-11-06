import { type DeadlineSchedule, realSchedule } from './machine-deadline.ts';

/** Whole-list reads share this budget, including reads asked for by different surfaces. */
export const LIST_REFRESH_MIN_MS = 10_000;

export interface ListRefreshEnvironment {
  readonly now: () => number;
  readonly schedule: DeadlineSchedule;
}

export const browserListRefreshEnvironment: ListRefreshEnvironment = { now: () => Date.now(), schedule: realSchedule };

/** One in-flight read and one trailing read. The cooldown starts when the request starts. */
export class ListRefresh<T> {
  #active: Promise<T> | undefined;
  #queued:
    | { readonly promise: Promise<T>; readonly cancel: () => void; readonly reject: (error: Error) => void }
    | undefined;
  #last = Number.NEGATIVE_INFINITY;
  #dirty = false;
  #stopped = false;

  constructor(
    private readonly read: () => Promise<T>,
    private readonly environment: ListRefreshEnvironment = browserListRefreshEnvironment,
    private readonly minMs = LIST_REFRESH_MIN_MS,
  ) {}

  request(): Promise<T> {
    if (this.#stopped) return Promise.reject(new Error('List refresh was cleared'));
    if (this.#active !== undefined) return this.#active;
    if (this.#queued !== undefined) return this.#queued.promise;
    const delay = this.#last + this.minMs - this.environment.now();
    if (delay <= 0) return this.#run();
    let reject!: (error: Error) => void;
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const cancel = this.environment.schedule(() => {
      this.#queued = undefined;
      resolve(this.#run());
    }, delay);
    this.#queued = { promise, cancel, reject };
    void promise.catch(() => undefined);
    return promise;
  }

  /** An event arriving during a read may describe a later write: read once more after it settles. */
  invalidate(): Promise<T> {
    if (this.#active !== undefined) this.#dirty = true;
    return this.request();
  }

  stop(): void {
    this.#stopped = true;
    this.#dirty = false;
    this.#queued?.cancel();
    this.#queued?.reject(new Error('List refresh was cleared'));
    this.#queued = undefined;
  }

  #run(): Promise<T> {
    this.#last = this.environment.now();
    const promise = new Promise<T>(resolve => resolve(this.read())).finally(() => {
      this.#active = undefined;
      if (this.#dirty) {
        this.#dirty = false;
        void this.request().catch(() => undefined);
      }
    });
    this.#active = promise;
    void promise.catch(() => undefined);
    return promise;
  }
}
