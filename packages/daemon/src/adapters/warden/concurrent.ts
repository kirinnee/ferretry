/**
 * Bounded async fan-out.
 *
 * A reports directory is unbounded — nothing prunes it — so mapping it through
 * an unbounded `Promise.all` opens one file descriptor per entry at once and
 * fails with EMFILE on a long-running host. That takes down the verdict list,
 * which is the surface that shows the fleet is unhealthy, exactly when the host
 * is under pressure.
 */

export const DEFAULT_READ_CONCURRENCY = 16;

/** Map `items` through `worker`, running at most `limit` at a time and keeping
 *  the input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  limit = DEFAULT_READ_CONCURRENCY,
): Promise<readonly R[]> {
  const results: R[] = Array.from({ length: items.length });
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: width }, runner));
  return results;
}
