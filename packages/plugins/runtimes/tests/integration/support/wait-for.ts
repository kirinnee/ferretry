/** How long a condition may take before the wait gives up: a safety net, never a budget. */
const SAFETY_NET_MS = 60_000;
const POLL_MS = 10;

export interface WaitForOptions {
  /** The safety net. The wait returns the moment the condition holds, so this is only ever spent on a failure. */
  readonly within?: number;
  readonly pollMs?: number;
  /** What to print under the failure, so a wait that expires explains itself (a daemon log, the last frame). */
  readonly evidence?: () => string | Promise<string>;
}

/**
 * Resolves with the first truthy value `condition` returns, polling it until then.
 *
 * Tests wait for the event they depend on, never for a duration: the deadline only exists so a
 * condition that can never hold fails the test naming it, instead of hanging the run.
 */
export async function waitFor<T>(
  condition: () => T | undefined | Promise<T | undefined>,
  what: string,
  { within = SAFETY_NET_MS, pollMs = POLL_MS, evidence }: WaitForOptions = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + within;
  for (;;) {
    const value = await condition();
    if (value) return value as NonNullable<T>;
    if (Date.now() >= deadline) {
      const detail = evidence === undefined ? '' : `\n${await evidence()}`;
      throw new Error(`waited ${within} ms for ${what}, and it never happened${detail}`);
    }
    await Bun.sleep(pollMs);
  }
}
