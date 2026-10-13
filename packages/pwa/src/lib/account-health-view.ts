/**
 * A RUNTIME'S HEALTH, IN WORDS: the status of the login it uses, as one row prints it.
 *
 * The daemon publishes the login's status word (`ready`, `refresh_due`, `needs_sign_in`, `checking`)
 * WITH its own label and one sentence saying why, so this module adds no copy of its own for them. What
 * it owns is the time clause beside the word and the tone, because those are a row's layout rather than
 * a fact about the login.
 *
 * ## The two sentences that must never merge
 *
 *   - `Never checked`    — nobody has looked. `lastCheckedAt` is absent.
 *   - `Checked 1m ago`   — somebody looked.
 *
 * Pure. No clock of its own: `now` is passed in, so a relative label is deterministic in a test and can
 * tick in the client without anything claiming a fresh check happened.
 */

import type { FleetCredentialStatusWord } from '@ferretry/protocol';
import type { PickerAccountHealth } from './account-picker-catalog.ts';

/** The tone a row paints itself with. */
export type AccountHealthTone = 'ok' | 'bad' | 'warn' | 'muted';

export interface AccountHealthView {
  /** The headline, in the daemon's own words: `Ready`, `Refresh due`, `Needs sign-in`, `Checking`. */
  readonly label: string;
  /** The instant clause beside it: `Checked 4m ago`, `Never checked`. */
  readonly checked: string;
  /** Why, in the daemon's own sentence. Always present: a bare word is not actionable. */
  readonly detail: string;
  /** A second clause when the newest check could not conclude, so the word rests on older evidence. */
  readonly secondary?: string;
  readonly tone: AccountHealthTone;
  /** Whether a sign-in control could possibly help. */
  readonly offersSignIn: boolean;
}

const WORD_TONE: Readonly<Record<FleetCredentialStatusWord, AccountHealthTone>> = {
  ready: 'ok',
  refresh_due: 'warn',
  needs_sign_in: 'bad',
  checking: 'muted',
};

/** Whole units, coarsest that fits. A reader wants "4m ago", never a millisecond count. */
export function relativeInstantLabel(instant: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - instant) / 1_000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** The exact instant, for the accessible name and the title. A relative label alone is not a time. */
export function absoluteInstantLabel(instant: number): string {
  return new Date(instant).toISOString();
}

/** When the login was last checked, as epoch milliseconds, or `null` when nobody has. */
export function lastCheckedAt(health: PickerAccountHealth): number | null {
  if (health.lastCheckedAt === undefined) return null;
  const at = Date.parse(health.lastCheckedAt);
  return Number.isNaN(at) ? null : at;
}

/** One runtime's login status as the words a row prints. */
export function accountHealthView(health: PickerAccountHealth, now: number): AccountHealthView {
  const checkedAt = lastCheckedAt(health);
  return {
    label: health.label,
    checked: checkedAt === null ? 'Never checked' : `Checked ${relativeInstantLabel(checkedAt, now)}`,
    detail: health.explanation,
    ...(health.lastCheckInconclusive && checkedAt !== null
      ? { secondary: `The check ${relativeInstantLabel(checkedAt, now)} was inconclusive.` }
      : {}),
    tone: WORD_TONE[health.word],
    offersSignIn: health.word === 'needs_sign_in',
  };
}

/** The row for a runtime whose login the daemon published no status for at all: unread, not unhealthy. */
export const UNREAD_ACCOUNT_HEALTH: AccountHealthView = Object.freeze({
  label: 'Unknown',
  checked: 'Never checked',
  detail: 'This machine has not said how this login is doing yet.',
  tone: 'muted' as const,
  offersSignIn: false,
});
