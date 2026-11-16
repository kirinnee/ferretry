/**
 * `fn` over every item with at most `limit` calls in flight, results in item order (today's
 * `lib/session/pack/bounded.ts`, unchanged). Items start in order, so a caller that stops early (by making `fn` cheap)
 * loses only the later ones. A rejection rejects the whole map.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) results[index] = await fn(items[index] as T, index);
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
