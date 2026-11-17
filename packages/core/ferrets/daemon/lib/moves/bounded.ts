/** How long the keeper gets to answer a question asked on the move's path (it lists tmux sessions to answer). */
export const KEEPER_TIMEOUT_MS = 5_000;

/**
 * `work`, or — when it has not answered within `ms` of the caller's clock (`sleep`) — rejection with a plain sentence. The
 * caller decides what a refusal to answer means: on the gate path it is "no attachment is proven", which fails closed (the
 * classifier decides alone).
 */
export async function bounded<T>(
  work: Promise<T>,
  ms: number,
  what: string,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  const late = sleep(ms).then((): never => {
    throw new Error(`${what} did not answer within ${ms} ms`);
  });
  // Whichever loses must not become an unhandled rejection.
  late.catch(() => undefined);
  work.catch(() => undefined);
  return await Promise.race([work, late]);
}
