/**
 * AN INSTANT ON THE VIEWER'S OWN CLOCK. The daemon writes instants (and a few display rows) in UTC; a person reading the page
 * wants the clock on their own wall, like every other time in the app. `Intl` reads the device's timezone, so nothing here
 * slices an ISO string. `timeZone` and `locale` are parameters only so a test can pin them.
 */

export interface LocalClock {
  readonly timeZone?: string | undefined;
  readonly locale?: string | undefined;
}

/** "Nov 2, 2026, 9:00 AM" in the viewer's zone; an instant that does not parse is returned as it came. */
export function localTimeWords(instant: string, clock: LocalClock = {}): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return instant;
  return new Intl.DateTimeFormat(clock.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(clock.timeZone === undefined ? {} : { timeZone: clock.timeZone }),
  }).format(date);
}

const UTC_STAMP = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/gu;

/** A sentence the daemon composed with "2026-11-02 09:00 UTC" stamps, with each stamp on the viewer's clock instead. */
export function localizeUtcStamps(text: string, clock: LocalClock = {}): string {
  return text.replace(UTC_STAMP, (_stamp, day: string, time: string) => localTimeWords(`${day}T${time}:00Z`, clock));
}
