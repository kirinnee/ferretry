/**
 * EVERY TIME A PERSON READS, ON THEIR OWN CLOCK, WITH THE ZONE NAMED.
 *
 * The daemon records instants (and some of its sentences carry "2026-11-02 09:00 UTC" stamps); a page must never print those
 * as they came. The rule is one: a time is shown in the VIEWER's zone, and a short zone label ("PST") follows it, so
 * "which clock" is never a guess. `Intl` reads the device's zone, so nothing here slices an ISO string or reads a `getUTC*`
 * field. `timeZone` and `locale` are parameters only so a test can pin them; production passes nothing.
 *
 * `viewerTime` is a date and a time ("Dec 1, 2026, 12:00 AM PST"), `viewerClock` is the time alone ("12:00 AM PST") and
 * `viewerZoneLabel` is the label by itself. A value that does not parse is returned as it came, never replaced by a dash:
 * it is data the daemon sent.
 */

export interface ViewerClock {
  readonly timeZone?: string | undefined;
  readonly locale?: string | undefined;
}

type Instant = string | number | Date;

const toDate = (instant: Instant): Date => (instant instanceof Date ? instant : new Date(instant));

const formatted = (instant: Instant, clock: ViewerClock, options: Intl.DateTimeFormatOptions): string | undefined => {
  const date = toDate(instant);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(clock.locale, {
    ...options,
    timeZoneName: 'short',
    ...(clock.timeZone === undefined ? {} : { timeZone: clock.timeZone }),
  }).format(date);
};

/** "Dec 1, 2026, 12:00 AM PST": a date and a time in the viewer's zone, the zone named. */
export function viewerTime(instant: Instant, clock: ViewerClock = {}): string {
  return (
    formatted(instant, clock, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }) ?? String(instant)
  );
}

/** "12:00 AM PST": the time of an instant in the viewer's zone, the zone named. */
export function viewerClock(instant: Instant, clock: ViewerClock = {}): string {
  return formatted(instant, clock, { hour: 'numeric', minute: '2-digit' }) ?? String(instant);
}

/** The viewer's zone as the short label a time carries ("PST", "GMT+8"), as of `at` (daylight saving moves it). */
export function viewerZoneLabel(clock: ViewerClock = {}, at: Instant = Date.now()): string {
  const parts = new Intl.DateTimeFormat(clock.locale, {
    timeZoneName: 'short',
    ...(clock.timeZone === undefined ? {} : { timeZone: clock.timeZone }),
  }).formatToParts(toDate(at));
  return parts.find(part => part.type === 'timeZoneName')?.value ?? '';
}

/** The viewer's IANA zone name ("America/Los_Angeles"); "UTC" when the runtime names none. */
export function viewerZoneName(clock: ViewerClock = {}): string {
  return clock.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
}

const UTC_STAMP = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/gu;

/** A sentence the daemon composed with "2026-11-02 09:00 UTC" stamps, each stamp on the viewer's clock, the zone named. */
export function viewerizeUtcStamps(text: string, clock: ViewerClock = {}): string {
  return text.replace(UTC_STAMP, (_stamp, day: string, time: string) => viewerTime(`${day}T${time}:00Z`, clock));
}
