/** The package's one condition wait: poll until something HAPPENED, never sleep for a time. */

export interface WaitOptions {
  /** A safety net, not a budget: how long to keep looking before failing. Never tune it to make a test pass. */
  readonly within?: number;
  /** How often to look again. */
  readonly every?: number;
}

const SAFETY_NET_MS = 30_000;
const POLL_MS = 10;

/** Resolve once `condition` holds; fail, naming `what` never happened, only at the safety net. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  options: WaitOptions = {},
): Promise<void> {
  await waitForValue(async () => ((await condition()) ? true : undefined), what, options);
}

/** Resolve with the first value `read` returns that is not `undefined`; fail naming `what` at the safety net. */
export async function waitForValue<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
  { within = SAFETY_NET_MS, every = POLL_MS }: WaitOptions = {},
): Promise<T> {
  const deadline = Date.now() + within;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${within} ms waiting for ${what}`);
    await Bun.sleep(every);
  }
}
