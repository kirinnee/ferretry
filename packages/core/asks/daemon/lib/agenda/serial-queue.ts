import type { SerialExecutor } from '../ports.ts';

/**
 * One thing at a time. A list kept as a file is read, changed and written back; two callers that interleave lose the
 * one that wrote first. Work given to `run` starts only when the work before it has settled, whether that
 * succeeded or failed, and a failure reaches only its own caller.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * One thing at a time per key (today's keyed `SerialExecutor`): work for one ferret waits for that ferret's earlier
 * work, never another's, and `runExclusive` waits for every key. A key's queue is dropped once it is idle.
 */
export class KeyedSerialQueue implements SerialExecutor {
  private readonly tails = new Map<string, Promise<unknown>>();
  private exclusive: Promise<unknown> = Promise.resolve();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = Promise.all([this.exclusive, this.tails.get(key)]);
    const next = before.then(work, work);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const before = Promise.all([this.exclusive, ...this.tails.values()]);
    const next = before.then(work, work);
    this.exclusive = next.catch(() => undefined);
    return next;
  }
}
