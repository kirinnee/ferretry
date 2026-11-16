import { z } from 'zod';
import type { Brand } from './brand.ts';

/**
 * An instant: an ISO-8601 UTC string (`2026-11-06T09:00:00.000Z`), the one spelling stored and compared
 * (docs/standards/datetime). Parse with {@link InstantSchema}; never build one by string concatenation.
 */
export type Instant = Brand<string, 'Instant'>;

/** Parses an offset-bearing ISO instant and canonicalises it to UTC, so equal moments compare equal. */
export const InstantSchema = z.iso
  .datetime({ offset: true })
  .transform(value => new Date(value).toISOString() as Instant);

export function instantFromEpochMs(ms: number): Instant {
  return new Date(ms).toISOString() as Instant;
}

export function epochMs(instant: Instant): number {
  return Date.parse(instant);
}

/** A span of time in whole milliseconds. Never a wall-clock reading. */
export type Duration = Brand<number, 'Duration'>;

export const DurationSchema = z
  .number()
  .int()
  .nonnegative()
  .transform(value => value as Duration);

export const milliseconds = (n: number): Duration => Math.max(0, Math.round(n)) as Duration;
export const seconds = (n: number): Duration => milliseconds(n * 1000);
export const minutes = (n: number): Duration => seconds(n * 60);
export const hours = (n: number): Duration => minutes(n * 60);

export function addDuration(instant: Instant, duration: Duration): Instant {
  return instantFromEpochMs(epochMs(instant) + duration);
}

export function between(earlier: Instant, later: Instant): Duration {
  return milliseconds(epochMs(later) - epochMs(earlier));
}

export function isBefore(a: Instant, b: Instant): boolean {
  return epochMs(a) < epochMs(b);
}

const DATE =
  '(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))';
const TIME = '(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?';
const OFFSET = '(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d))';
const ISO_INSTANT = new RegExp(`^${DATE}T(?:${TIME}${OFFSET})$`);

/** The same accepted set as {@link InstantSchema}, without zod (for workers that must not load it). */
export const isIsoInstant = (value: string): boolean => ISO_INSTANT.test(value);
