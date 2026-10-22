/**
 * Quote a value for POSIX shell as an inert literal: wrap in single quotes and close/reopen around
 * any embedded single quote. Nothing inside the result is expanded.
 *
 * A module of its own, with no imports, so the usage schemas can use it without carrying the wrapper
 * generator and everything it imports into a thread that only reads usage.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}
