/**
 * What switching a login or a runtime off SAYS and sends — the pure half of `./disable-switch.tsx`
 * (docs/disabling.md).
 *
 * A disabled login or runtime is kept, just not used for new starts: the daemon publishes it unavailable
 * with a reason, and ferrets already on it keep going. This module words that, turns the person's choices
 * (a reason, "for a day", "until a date") into the one change they add up to, and works out which switch
 * owns the block: a runtime that is off because its LOGIN is off is turned back on from the login.
 */

import type { FleetAccountChange, FleetDisabled } from '@ferretry/protocol';

/** The longest reason the daemon takes. */
export const REASON_LIMIT = 200;

/** What a switch is for: a login by its id, a runtime by its name. */
export type DisableTarget =
  | { readonly kind: 'login'; readonly id: string }
  | { readonly kind: 'runtime'; readonly name: string };

/** How long a switch-off lasts. */
export type UntilChoice = 'forever' | 'day' | 'week' | 'date';

export const UNTIL_CHOICES: readonly { readonly value: UntilChoice; readonly label: string }[] = [
  { value: 'forever', label: 'Until I turn it on' },
  { value: 'day', label: 'For 1 day' },
  { value: 'week', label: 'For 1 week' },
  { value: 'date', label: 'Until a date…' },
];

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What a chosen length comes to: the instant it ends (or none), or why it cannot be used. */
export type UntilResult =
  | { readonly kind: 'ok'; readonly until?: string }
  | { readonly kind: 'problem'; readonly message: string };

/**
 * The instant a switch-off ends. A day or a week counts from `now` (ms); a date is the START of that
 * day in UTC, which is how the daemon reads a bare date too, and it must still be ahead.
 */
export const untilFor = (choice: UntilChoice, date: string, now: number): UntilResult => {
  if (choice === 'forever') return { kind: 'ok' };
  if (choice === 'day') return { kind: 'ok', until: new Date(now + DAY_MS).toISOString() };
  if (choice === 'week') return { kind: 'ok', until: new Date(now + 7 * DAY_MS).toISOString() };
  if (!DATE.test(date)) return { kind: 'problem', message: 'Pick the day it comes back.' };
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return { kind: 'problem', message: 'That is not a real day.' };
  if (ms <= now) return { kind: 'problem', message: 'Pick a day after today.' };
  return { kind: 'ok', until: new Date(ms).toISOString() };
};

/** Why a reason cannot be sent, or `null`. Blank is fine: the reason is optional. */
export const reasonProblem = (reason: string): string | null =>
  reason.trim().length > REASON_LIMIT ? `Keep it under ${String(REASON_LIMIT)} characters.` : null;

/** The change that switches the target off. */
export const disableChange = (target: DisableTarget, reason: string, until: string | undefined): FleetAccountChange => {
  const why = reason.trim();
  const rest = { ...(why === '' ? {} : { reason: why }), ...(until === undefined ? {} : { until }) };
  return target.kind === 'login'
    ? { kind: 'credential.disable', id: target.id, ...rest }
    : { kind: 'runtime.disable', name: target.name, ...rest };
};

/** The change that switches the target back on. */
export const enableChange = (target: DisableTarget): FleetAccountChange =>
  target.kind === 'login'
    ? { kind: 'credential.enable', id: target.id }
    : { kind: 'runtime.enable', name: target.name };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** An instant as a short UTC date, with the time only when it is not the start of a day: "1 Nov 2026". */
export const untilWords = (until: string): string => {
  const ms = Date.parse(until);
  if (Number.isNaN(ms)) return until;
  const at = new Date(ms);
  const day = `${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? ''} ${String(at.getUTCFullYear())}`;
  if (at.getUTCHours() === 0 && at.getUTCMinutes() === 0) return day;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${day}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
};

/** The "why and until when" sentence under a switch that is off. */
export const disabledDetail = (disabled: FleetDisabled): string => {
  const why = disabled.reason === undefined ? '' : disabled.reason;
  const until =
    disabled.until === undefined ? 'Stays off until you turn it on.' : `Back on ${untilWords(disabled.until)}.`;
  return why === '' ? until : `${why.replace(/[.!?]$/, '')}. ${until}`;
};

/** Said wherever a switch-off is offered or shown: what it does NOT do. */
export const KEEPS_RUNNING =
  'Nothing is stopped. Ferrets already on it keep going; move one with fy migrate <id> -a <other runtime>.';

/** What a switch-off does to new starts. */
export const BLOCKS_STARTS = 'New starts, recommendations and failover skip it while it is off.';

/** Which switch holds a block: a runtime's own, or the one on its login. */
export type SwitchOwner = 'own' | 'login';

/** Whose block this is, from the view: only a runtime can carry its login's block. */
export const switchOwner = (target: DisableTarget, disabled: FleetDisabled): SwitchOwner =>
  target.kind === 'runtime' && disabled.source === 'login' ? 'login' : 'own';

/** What a switch that is off says in one line: it does NOT stop what is already running. */
export const OFF_HELPER = 'Off: new starts won’t use it; running ferrets keep going';

/** The line under the account line of a switch that is off. */
export const offHeadline = (target: DisableTarget, disabled: FleetDisabled, loginId: string): string =>
  switchOwner(target, disabled) === 'login' ? `Off because its login ${loginId} is disabled` : OFF_HELPER;
