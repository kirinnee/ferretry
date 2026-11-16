/**
 * THE READER'S DAY, FOR THE ANALYTICS LABELS `day` AND `week`.
 *
 * A session is stored as an INSTANT (`createdAt`, UTC). Which calendar day that instant belongs to is a
 * question about a person's clock, so it is answered here, per request, in the zone the caller names —
 * never baked into the row at ingestion. The stored `day`/`week` stay the UTC answer and remain what a
 * caller who names no zone gets (see docs/standards/datetime: the zone lives on the OWNER, the instant is
 * what is stored, conversion happens at the moment of rendering).
 *
 * `Intl` is the zone database here, as it is for the rest of the codebase's clocks; zones are IANA names
 * (`Asia/Singapore`), never an abbreviation or a fixed offset, so a day that is 23 or 25 hours long
 * around a DST change lands every session on the right side of it.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, made);
  return made;
}

/**
 * Whether `name` is an IANA REGION zone this runtime can build a formatter for (or `UTC`).
 *
 * The test is the SHAPE of the answer, not a list: `Intl.supportedValuesOf` differs by engine (Node lists
 * `Asia/Calcutta`, Bun `Asia/Kolkata`), so a list would refuse a zone whose rules this runtime holds. A
 * region name contains an `Area/` and resolves to one (`Etc/UTC` resolves to `UTC`). `Intl` also accepts
 * legacy fixed-offset names (`EST` is UTC-05 all year, with no daylight saving), which resolve without an
 * area and would count days wrongly for a reader in that region; those, offsets (`GMT+8`, `+08:00`),
 * abbreviations (`SGT`), padded names and junk are refused.
 */
export function isTimeZone(name: string): boolean {
  if (name === 'UTC') return true;
  if (name.trim() !== name || !name.includes('/')) return false;
  try {
    const resolved = formatter(name).resolvedOptions().timeZone;
    return resolved.includes('/') || resolved === 'UTC';
  } catch {
    return false;
  }
}

interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallClock(epochMs: number, timeZone: string): Wall {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(epochMs))
      .map(p => [p.type, p.value]),
  );
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    second: Number(parts['second']),
  };
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
const dateText = (date: Date): string =>
  `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** The calendar date `instant` falls on in `timeZone` (`YYYY-MM-DD`), or null when it is not an instant. */
export function zonedDay(instant: string, timeZone: string): string | null {
  const at = Date.parse(instant);
  if (!Number.isFinite(at)) return null;
  const wall = wallClock(at, timeZone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** The Monday of the week `instant` falls in, in `timeZone`, as a date; null when it is not an instant. */
export function zonedWeek(instant: string, timeZone: string): string | null {
  const day = zonedDay(instant, timeZone);
  if (day === null) return null;
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return dateText(date);
}

/** How far the zone's wall clock is ahead of UTC at `epochMs`, in milliseconds. */
function offsetAt(epochMs: number, timeZone: string): number {
  const wall = wallClock(epochMs, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(epochMs / 1_000) * 1_000;
}

/**
 * The instant a zone's wall clock first reads midnight of `date` (`YYYY-MM-DD`).
 *
 * Solved by iterating the offset, which converges in two steps except across a transition that skips
 * midnight itself; there the first instant of the day after the gap is the answer, which is what the
 * clock shows first. When a transition REPEATS midnight (Asia/Gaza 2020-10-24, Asia/Amman 2021-10-29: the
 * clock goes back from 01:00 to 00:00) the iteration lands on the second reading, so it steps back to
 * the earliest instant of the day, the one a `day` matcher also starts the day at.
 */
export function zonedMidnight(date: string, timeZone: string): number {
  const naive = Date.parse(`${date}T00:00:00Z`);
  let guess = naive - offsetAt(naive, timeZone);
  guess = naive - offsetAt(guess, timeZone);
  // A gap can leave the guess on the previous day's clock; step forward to the first reading of `date`.
  while (zonedDay(new Date(guess).toISOString(), timeZone)! < date) guess += 60_000;
  // A repeated midnight leaves the guess an hour late; the first reading is the day's real start.
  while (zonedDay(new Date(guess - 60_000).toISOString(), timeZone)! >= date) guess -= 60_000;
  return guess;
}

/** The date of a UTC-midnight instant as `YYYY-MM-DD`. */
export function utcDateOf(epochMs: number): string {
  return dateText(new Date(epochMs));
}
