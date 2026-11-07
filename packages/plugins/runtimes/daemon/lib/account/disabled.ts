/**
 * Switching a login or a runtime off without deleting it.
 *
 * `disabled: { reason, until }` on a `logins/<id>.yaml` or a `runtimes/<name>.yaml`. While it is in
 * effect the runtime (or every runtime on the login) is published UNAVAILABLE with a reason, so a
 * start refuses it, a recommendation, Pack routing, the Warden's failover and auto-resume skip it, and
 * its wrapper says why. Nothing running is touched: a ferret already on it keeps going.
 *
 * `until` is an instant (`2026-11-01T00:00:00Z`) or a calendar date, which means the START of that
 * day in UTC. Once it has passed the block is gone with no edit — `activeDisable` is evaluated against
 * a clock by whoever publishes, and the daemon republishes when the earliest `until` falls due.
 *
 * Pure: no clock of its own.
 */
import { z } from 'zod';

const UNTIL_DATE = z.iso.date();
const UNTIL_INSTANT = z.iso.datetime({ offset: true });

/** The longest reason a person may give. */
export const DISABLED_REASON_LIMIT = 200;

export const DisabledSchema = z.strictObject({
  /** Why, in the person's words: shown beside the switch and in every refusal. */
  reason: z.string().trim().min(1).max(DISABLED_REASON_LIMIT).optional(),
  /** When it switches itself back on. Absent: it stays off until someone enables it. */
  until: z
    .string()
    .refine(value => UNTIL_INSTANT.safeParse(value).success || UNTIL_DATE.safeParse(value).success, {
      message: 'write "until" as a date (2026-11-01) or a time (2026-11-01T09:00:00Z)',
    })
    .optional(),
});
export type Disabled = z.infer<typeof DisabledSchema>;

/** The instant `until` names, in milliseconds; `undefined` when it names none. */
export function disabledUntilMs(until: string | undefined): number | undefined {
  if (until === undefined) return undefined;
  const ms = Date.parse(until);
  return Number.isNaN(ms) ? undefined : ms;
}

/** The `disabled` block when it is in effect at `now` (ms), else `undefined`: an `until` in the past is no block. */
export function activeDisable(disabled: Disabled | undefined, now: number): Disabled | undefined {
  if (disabled === undefined) return undefined;
  const until = disabledUntilMs(disabled.until);
  return until !== undefined && until <= now ? undefined : disabled;
}

/** The earliest `until` still in the future across these blocks, or `undefined` when none will fall due. */
export function nextDisableExpiry(blocks: readonly (Disabled | undefined)[], now: number): number | undefined {
  const due = blocks
    .map(block => disabledUntilMs(block?.until))
    .filter((ms): ms is number => ms !== undefined && ms > now);
  return due.length === 0 ? undefined : Math.min(...due);
}

/** `until` as a short calendar date for a sentence (UTC, `2026-11-01`). */
const untilWords = (until: string): string => {
  const ms = disabledUntilMs(until);
  if (ms === undefined) return until;
  const iso = new Date(ms).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 16).replace('T', ' ')} UTC`;
};

/** "disabled (spend limit reached) until 2026-11-01" — the clause every refusal and row builds on. */
export function disabledPhrase(disabled: Disabled): string {
  const why = disabled.reason === undefined ? '' : ` (${disabled.reason})`;
  const until = disabled.until === undefined ? '' : ` until ${untilWords(disabled.until)}`;
  return `disabled${why}${until}`;
}
