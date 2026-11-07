/**
 * Runs critical sections one after another. The proposal board is one document rewritten whole, so two verdicts that
 * both read before either wrote would silently lose one; the lock belongs with the file, not with the route.
 */
export class SerialSection {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
