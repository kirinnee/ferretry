/**
 * The words for WHEN, for `snooze_attention` — pure. The owner is in Pacific time, so a time written without a zone
 * is Pacific (`America/Los_Angeles`, daylight saving included), and every wake time the connector says aloud is said in
 * Pacific. The instant that reaches the daemon is always an absolute ISO-8601 UTC time: the daemon's own snooze
 * (`agenda` action `snooze`) takes nothing else.
 *
 * Accepted, for `until`: an ISO time with a zone (`2026-11-25T09:00:00Z`, `…-08:00`) or without (`2026-11-25T09:00`,
 * Pacific); a date alone (`2026-11-25`, 9:00 AM Pacific that day); a clock time (`17:00`, `5pm`: its next occurrence);
 * and `today` or `tomorrow` with a clock time (`tomorrow 9am`). For `duration`: `90m`, `2h`, `1d`, `1w`, a few together
 * (`1d 2h`), with an optional leading "in". Anything else is refused with the forms on offer, never guessed.
 */

export const OWNER_ZONE = 'America/Los_Angeles';
/** Under a minute is the same as refusing: the daemon's timer looks once a minute. */
export const SNOOZE_MIN_MS = 60_000;
/** A snooze is "not now", not "never": a month at most, so an item cannot be put away and forgotten. */
export const SNOOZE_MAX_MS = 30 * 86_400_000;

const UNTIL_FORMS =
  'an ISO time with a zone (2026-11-25T09:00:00Z) or without one (2026-11-25T09:00, read as Pacific time), a date (2026-11-25, 9:00 AM Pacific), a clock time (17:00 or 5pm, the next one) or "tomorrow 9am"';
const DURATION_FORMS = 'a wait like 90m, 2h, 1d or 1d 2h';

export type TimeResult = { readonly ok: true; readonly at: number } | { readonly ok: false; readonly problem: string };

const UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

const DURATION = /^(?:in\s+)?((?:\d+(?:\.\d+)?\s*[a-z]+\s*(?:and\s+|,\s*)?)+)$/iu;
const DURATION_PART = /(\d+(?:\.\d+)?)\s*([a-z]+)/giu;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/iu;
const CLOCK = /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/iu;
const DAY_CLOCK = /^(today|tomorrow)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/iu;

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: OWNER_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});
const wordsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: OWNER_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The Pacific wall clock at an instant. */
function wallAt(ms: number): Wall {
  const get = (type: string): number =>
    Number(partsFormat.formatToParts(new Date(ms)).find(part => part.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

const wallAsUtc = (wall: Wall): number =>
  Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

/** The instant at which the Pacific wall clock reads `wall` (the earlier one in a repeated hour; a skipped hour reads an hour later). */
function instantOfWall(wall: Wall): number {
  const asUtc = wallAsUtc(wall);
  const offsetAt = (ms: number): number => wallAsUtc(wallAt(ms)) - Math.floor(ms / 1000) * 1000;
  const first = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(first);
}

/** A wall clock that exists on the calendar (no 30 February, no 25:00). */
const validWall = (wall: Wall): boolean => {
  const back = new Date(wallAsUtc(wall));
  return (
    wall.hour < 24 &&
    wall.minute < 60 &&
    wall.second < 60 &&
    back.getUTCFullYear() === wall.year &&
    back.getUTCMonth() === wall.month - 1 &&
    back.getUTCDate() === wall.day
  );
};

const refuse = (problem: string): TimeResult => ({ ok: false, problem });

const sameWall = (left: Wall, right: Wall): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute &&
  left.second === right.second;

/**
 * The instant at which Pacific clocks read `wall`. A time the clocks skip (02:30 on the day daylight saving starts)
 * is refused in a plain sentence rather than moved an hour. The hour that repeats when the clocks go back reads as
 * its first occurrence (a documented limitation).
 */
function atWall(wall: Wall, said: string): TimeResult {
  const at = instantOfWall(wall);
  return sameWall(wallAt(at), wall)
    ? { ok: true, at }
    : refuse(`"${said}" does not exist in Pacific time (the clocks skip it that day). Pick a time before or after it.`);
}

function hourOf(hour: number, meridiem: string | undefined): number | undefined {
  if (meridiem === undefined) return hour <= 23 ? hour : undefined;
  if (hour < 1 || hour > 12) return undefined;
  const pm = meridiem.toLowerCase() === 'pm';
  return (hour % 12) + (pm ? 12 : 0);
}

/** `until` as an instant (epoch ms), relative to `now`. */
export function parseSnoozeUntil(raw: string, now: number): TimeResult {
  const value = raw.trim();
  const bad = refuse(`"${value}" is not a time I can read. Use ${UNTIL_FORMS}.`);

  const iso = ISO.exec(value);
  if (iso !== null) {
    const [, year, month, day, hour, minute, second, zone] = iso;
    const wall: Wall = {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: hour === undefined ? (zone === undefined ? 9 : 0) : Number(hour),
      minute: minute === undefined ? 0 : Number(minute),
      second: second === undefined ? 0 : Number(second),
    };
    // The calendar fields are checked for a zoned time too: Date.parse rolls 2026-02-29 over to 1 March.
    if (!validWall(wall)) return bad;
    if (zone !== undefined) {
      const ms = Date.parse(value.replace(' ', 'T').replace(/\s+(?=Z|[+-]\d)/iu, ''));
      return Number.isFinite(ms) ? { ok: true, at: ms } : bad;
    }
    return atWall(wall, value);
  }

  const dayClock = DAY_CLOCK.exec(value);
  const clock = dayClock === null ? CLOCK.exec(value) : null;
  if (dayClock !== null || clock !== null) {
    const [hourText, minuteText, meridiem] =
      dayClock === null ? [clock?.[1], clock?.[2], clock?.[3]] : [dayClock[2], dayClock[3], dayClock[4]];
    const hour = hourOf(Number(hourText), meridiem);
    const minute = minuteText === undefined ? 0 : Number(minuteText);
    if (hour === undefined || minute > 59) return bad;
    const today = wallAt(now);
    const base = { year: today.year, month: today.month, day: today.day, hour, minute, second: 0 };
    if (dayClock !== null) {
      const shift = dayClock[1]?.toLowerCase() === 'tomorrow' ? 1 : 0;
      const date = new Date(Date.UTC(today.year, today.month - 1, today.day + shift));
      return atWall(
        { ...base, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
        value,
      );
    }
    const todayAt = atWall(base, value);
    if (!todayAt.ok || todayAt.at > now) return todayAt;
    const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    return atWall(
      { ...base, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
      value,
    );
  }
  return bad;
}

/** `duration` as an instant (epoch ms): `now` plus the wait. */
export function parseSnoozeDuration(raw: string, now: number): TimeResult {
  const value = raw.trim();
  const bad = refuse(`"${value}" is not a wait I can read. Use ${DURATION_FORMS}.`);
  const whole = DURATION.exec(value);
  if (whole?.[1] === undefined) return bad;
  let total = 0;
  for (const part of whole[1].matchAll(DURATION_PART)) {
    const unit = UNIT_MS[(part[2] ?? '').toLowerCase()];
    if (unit === undefined) return bad;
    total += Number(part[1]) * unit;
  }
  return total > 0 && Number.isFinite(total) ? { ok: true, at: now + Math.round(total) } : bad;
}

/** "Tue, Nov 25, 9:00 AM PST": a wake time as the owner reads it. */
export function pacificWords(ms: number): string {
  return wordsFormat.format(new Date(ms));
}

/** "in 2 h", "in 3 days": how far ahead, roughly. */
export function inWords(now: number, ms: number): string {
  const minutes = Math.max(1, Math.round((ms - now) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}
