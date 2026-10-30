/**
 * SNOOZING AN AGENDA ITEM, as pure decisions: the times the menu offers, the one the owner types, and the
 * refusal for a time that has already passed. Every time is the owner's LOCAL clock; the wire takes an instant.
 *
 * `now` is always passed in, so "Tomorrow 9:00" is testable in any time zone.
 */

const HOUR_MS = 3_600_000;
const MORNING_HOUR = 9;

/** One ready-made snooze: the words the menu says and the instant it sends. */
export interface SnoozeChoice {
  readonly id: 'hour' | 'hours' | 'tomorrow';
  readonly label: string;
  readonly until: string;
}

/** 9:00 on the day after `now`'s local day — still tomorrow when it is before 9:00 today. */
export const tomorrowMorning = (now: number): number => {
  const today = new Date(now);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, MORNING_HOUR, 0, 0, 0).getTime();
};

/** "1 hour", "4 hours" and "Tomorrow 9:00", each as the instant it snoozes until. */
export const snoozeChoices = (now: number): readonly SnoozeChoice[] => [
  { id: 'hour', label: '1 hour', until: new Date(now + HOUR_MS).toISOString() },
  { id: 'hours', label: '4 hours', until: new Date(now + 4 * HOUR_MS).toISOString() },
  { id: 'tomorrow', label: 'Tomorrow 9:00', until: new Date(tomorrowMorning(now)).toISOString() },
];

const two = (value: number): string => String(value).padStart(2, '0');

/** A local instant as a `datetime-local` input reads it: `2026-10-30T15:00`. */
export const localInputValue = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
};

export type CustomSnooze =
  | { readonly ok: true; readonly until: string }
  | { readonly ok: false; readonly message: string };

/** A typed `datetime-local` value as an instant — or the sentence that says why it cannot be one. */
export const customSnooze = (value: string, now: number): CustomSnooze => {
  const at = value === '' ? Number.NaN : new Date(value).getTime();
  if (Number.isNaN(at)) return { ok: false, message: 'Pick a date and a time.' };
  if (at <= now) return { ok: false, message: 'That time has passed — pick a later one.' };
  return { ok: true, until: new Date(at).toISOString() };
};
