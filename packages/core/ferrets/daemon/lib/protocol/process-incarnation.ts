/**
 * Tells one run of a pid apart from a later process that reuses the same number.
 *
 * The value is only ever compared for equality with another read on the same host, so its unit is
 * each platform's own: Linux clock ticks since boot, macOS whole seconds since the epoch. Both are
 * positive safe integers, which is the shape a stored pane registration already carries.
 *
 * The daemon writes this value into a pane registration and the CLI re-reads it before `fy attach`
 * hands over a terminal. They are different programs that must produce the SAME number for the same
 * process, so there is exactly one definition of it — this one, read through
 * `@ferretry/protocol/process-incarnation` by both. See `docs/standards/fact-ownership`.
 */
export interface ProcessIncarnation {
  /** `undefined` when the process is gone or unreadable; throws only when the platform has no source. */
  startOf(pid: number): Promise<number | undefined>;
}

function positive(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Field 22 of `/proc/<pid>/stat`, counted after the parenthesised command name that may hold spaces. */
export function procStatStartTicks(text: string): number | undefined {
  const close = text.lastIndexOf(')');
  if (close < 1) return undefined;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  if (fields.length < 20) return undefined;
  return positive(Number(fields[19]));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `ps -o lstart=` under `LC_ALL=C` and `TZ=UTC0`: `Sat Sep  6 18:48:09 2026`, as epoch seconds.
 *
 * Both variables are pinned by the caller because the text is otherwise localised AND local time,
 * so a daylight-saving change between registering a pane and reaping it would make the same
 * process read as a different one.
 */
export function psStartSeconds(text: string): number | undefined {
  const match = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(text.trim());
  if (match === null) return undefined;
  const [, month, day, hour, minute, second, year] = match;
  const monthIndex = MONTHS.indexOf(month ?? '');
  if (monthIndex < 0) return undefined;
  const millis = Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second));
  return positive(millis / 1000);
}
