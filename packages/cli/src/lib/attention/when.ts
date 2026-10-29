const UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const RELATIVE = /^in\s+((?:\d+\s*[mhdw]\s*)+)$/iu;
const RELATIVE_PART = /(\d+)\s*([mhdw])/giu;
const CLOCK = /^(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)$/iu;
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/iu;

/** What `--by` accepts, for the error that refuses anything else. */
const BY_FORMS = 'an ISO time (2026-10-29T17:00:00Z), a wait ("in 3h", "in 90m", "in 1d"), or a clock time ("17:00")';

/**
 * Read the time a person typed for `--by` as an instant, relative to `nowMs` and the zone this process
 * runs in. A clock time is its next occurrence (today if still ahead, else tomorrow); an ISO time without
 * an offset is local. Anything else is refused with the forms on offer — a guess would pin a deadline the
 * owner never meant.
 */
export function parseNeededBy(raw: string, nowMs: number): string {
  const value = raw.trim();
  const fail = (): never => {
    throw new Error(`--by "${value}" is not a time: use ${BY_FORMS}`);
  };

  const relative = RELATIVE.exec(value);
  if (relative?.[1] !== undefined) {
    const total = [...relative[1].matchAll(RELATIVE_PART)].reduce(
      (sum, part) => sum + Number(part[1]) * (UNIT_MS[(part[2] ?? '').toLowerCase()] ?? 0),
      0,
    );
    if (total <= 0) return fail();
    return new Date(nowMs + total).toISOString();
  }

  const clock = CLOCK.exec(value);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    const at = new Date(nowMs);
    at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }

  if (ISO.test(value)) {
    const parsed = new Date(value.replace(' ', 'T'));
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return fail();
}
