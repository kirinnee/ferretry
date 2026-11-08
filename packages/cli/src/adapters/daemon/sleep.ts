/** A pause that ends at once, quietly, when the signal aborts: the restart backoff must not outlast a caller who left. */
export function sleepUnlessAborted(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return Bun.sleep(milliseconds);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
