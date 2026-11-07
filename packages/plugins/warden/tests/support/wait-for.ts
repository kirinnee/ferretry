/** Polls until the check passes or the time is up (real timers: integration tests only). */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  label = 'the condition',
  timeoutMs = 2_000,
  stepMs = 5,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`waitFor: ${label} did not become true in time`);
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}
