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

/** The same accepted set as {@link InstantSchema}, without zod: a worker imports it from `@ferretry/std/iso-instant`. */
export { isIsoInstant } from './iso-instant.ts';
