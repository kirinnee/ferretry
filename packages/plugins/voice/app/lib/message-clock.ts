/**
 * A MESSAGE'S TIME, ON THE READER'S OWN CLOCK.
 *
 * The daemon records an instant; what a phone should show is that instant on the clock hanging on the
 * reader's wall. So every time a transcript row prints goes through here and through `Intl`, which
 * reads the device's own timezone — nothing slices an ISO string or reads a `getUTC*` field.
 *
 * `short` is what a bubble shows (`HH:MM`, 24-hour whatever the locale, so two rows never differ in
 * style); `full` is the tooltip and the tap read-out: the date, the time to the second and the zone,
 * so "which day, which clock" is never a guess. `timeZone` and `locale` are parameters only so a test
 * can pin them; production passes nothing and gets the device's.
 */

export interface MessageClock {
  readonly short: string;
  readonly full: string;
}

export interface ClockEnvironment {
  readonly timeZone?: string | undefined;
  readonly locale?: string | undefined;
}

const formatters = new Map<string, readonly [Intl.DateTimeFormat, Intl.DateTimeFormat]>();

const formattersFor = ({ timeZone, locale }: ClockEnvironment): readonly [Intl.DateTimeFormat, Intl.DateTimeFormat] => {
  const key = `${locale ?? ''}|${timeZone ?? ''}`;
  const cached = formatters.get(key);
  if (cached !== undefined) return cached;
  const zone = timeZone === undefined ? {} : { timeZone };
  const made = [
    new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...zone }),
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long', hourCycle: 'h23', ...zone }),
  ] as const;
  formatters.set(key, made);
  return made;
};

/** The reader's local time of an instant; `undefined` for one that does not parse. */
export const clockOfInstant = (
  at: number | string | undefined,
  environment: ClockEnvironment = {},
): MessageClock | undefined => {
  if (at === undefined) return undefined;
  const date = new Date(typeof at === 'number' ? at : Date.parse(at));
  if (!Number.isFinite(date.getTime())) return undefined;
  const [short, full] = formattersFor(environment);
  return { short: short.format(date), full: full.format(date) };
};
