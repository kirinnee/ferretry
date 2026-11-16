/** Instant parsing (today's `lib/warden/time.ts`), shared by the session sweeps. */

/** Epoch milliseconds for an ISO instant, or `undefined` when absent or unparseable. */
export function instantMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Render epoch milliseconds back to an ISO instant. */
export function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}
