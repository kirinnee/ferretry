/** Instant parsing shared by the warden's pure modules. */

/** Epoch milliseconds for an ISO instant, or `undefined` when absent or unparseable. */
export function instantMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The latest of a set of instants, or `undefined` when none parse. */
export function latestInstantMs(...values: readonly (string | undefined)[]): number | undefined {
  let latest: number | undefined;
  for (const value of values) {
    const parsed = instantMs(value);
    if (parsed !== undefined && (latest === undefined || parsed > latest)) latest = parsed;
  }
  return latest;
}

/** The first instant of the list that parses, in priority order. */
export function firstInstantMs(...values: readonly (string | undefined)[]): number | undefined {
  for (const value of values) {
    const parsed = instantMs(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** Render epoch milliseconds back to an ISO instant. */
export function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}
