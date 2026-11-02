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
