import { WAITING_BACKSTOP_MS } from '../../warden/detect.ts';
import { SignalRefused, type DeclaredWait, type SignalTarget } from './types.ts';

/**
 * The pure decisions a signal makes, with no clock and no filesystem of their own.
 *
 * Everything here is a function of the values handed to it, which is what makes the two rules that
 * matter testable: a deadline can never outrun the backstop, and a park always ends.
 */

/** The summary a completion writes when the teammate gave no message. Never an absent file. */
export const DEFAULT_COMPLETION_SUMMARY = 'Task completed; inspect chat and repository diff.\n';

/** The `--until` argument is not a duration and not a date. Distinct so the route can answer `400`. */
export class InvalidDeadlineRefused extends SignalRefused {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDeadlineRefused';
  }
}

/** `1h30m`, `45m`, `90s` — hours, minutes and seconds in that order, each part optional. */
const DURATION = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/iu;

/** An ISO-8601 date, anchored at the year. Nothing looser may reach `Date.parse`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]|$)/u;

/**
 * Turns an `until` argument into an ISO deadline.
 *
 * ONLY A REAL ISO DATE IS HANDED TO `Date.parse`, which is far looser than it looks: it reads a bare
 * `45` as the YEAR 2045. The very plausible typo `--until 45` (meaning 45 minutes) would otherwise
 * have parked a session, unsupervised, for two decades — no nudge, no stall kill, no turn ceiling,
 * and no warden verdict.
 *
 * THE BACKSTOP IS A CEILING ON EVERY WAIT, not only the open-ended ones. A park must always end
 * within a bounded time of when it was declared, so a deadline further out than the backstop is
 * clamped to it rather than refused: the teammate asked for something reasonable and simply gets
 * woken earlier, which is a resumable event rather than a failed signal.
 */
export function parseDeadline(value: string, fromMs: number, backstopMs: number = WAITING_BACKSTOP_MS): string {
  const text = value.trim();
  if (text === '') throw new InvalidDeadlineRefused('until requires a duration (45m, 2h) or an ISO timestamp');
  const duration = DURATION.exec(text);
  if (duration?.slice(1).some(part => part !== undefined)) {
    const [hours, minutes, seconds] = duration.slice(1).map(part => Number(part ?? 0)) as [number, number, number];
    const milliseconds = (hours * 3600 + minutes * 60 + seconds) * 1000;
    if (milliseconds <= 0) throw new InvalidDeadlineRefused('until must be a positive duration');
    return new Date(fromMs + Math.min(milliseconds, backstopMs)).toISOString();
  }
  if (!ISO_DATE.test(text))
    throw new InvalidDeadlineRefused(
      `could not read ${JSON.stringify(value)} as a duration (45m, 2h, 90s) or an ISO timestamp`,
    );
  const absolute = Date.parse(text);
  if (!Number.isFinite(absolute))
    throw new InvalidDeadlineRefused(`could not read ${JSON.stringify(value)} as a duration or ISO timestamp`);
  if (absolute <= fromMs) throw new InvalidDeadlineRefused(`until ${value} is already in the past`);
  return new Date(Math.min(absolute, fromMs + backstopMs)).toISOString();
}

/** What a session is called when something has to name it to a human. */
export function signalDisplayName(target: SignalTarget): string {
  return target.teammate ?? target.id;
}

/** The wait to record, composed from the resolved peer rather than the reference the caller gave. */
export function composeWait(
  sinceIso: string,
  until: string | undefined,
  condition: string | undefined,
  peer: SignalTarget | undefined,
): DeclaredWait {
  return {
    since: sinceIso,
    ...(until === undefined ? {} : { until }),
    ...(condition === undefined ? {} : { condition }),
    ...(peer === undefined
      ? {}
      : { peer: peer.id, ...(peer.teammate === undefined ? {} : { peerName: peer.teammate }) }),
  };
}

/** The one-line account of a park, for the status every other surface reads. */
export function waitDetail(wait: DeclaredWait, message: string | undefined): string {
  const subject = wait.peer === undefined ? (wait.condition ?? message) : `reply from ${wait.peerName ?? wait.peer}`;
  return [subject, wait.until === undefined ? 'open-ended' : `until ${wait.until}`].filter(Boolean).join(' — ');
}

/**
 * How long a park actually lasted, in whole seconds.
 *
 * Zero when the recorded start will not parse: a credit is a concession against the turn ceiling, and
 * an unreadable timestamp must not be turned into an arbitrarily large one.
 */
export function parkedSeconds(wait: DeclaredWait, nowMs: number): number {
  const since = Date.parse(wait.since);
  return Number.isFinite(since) ? Math.max(0, Math.round((nowMs - since) / 1000)) : 0;
}

/** The running credit after this park is added to whatever the session had already banked. */
export function creditedSeconds(target: SignalTarget, wait: DeclaredWait, nowMs: number): number {
  return (target.waitingCreditSeconds ?? 0) + parkedSeconds(wait, nowMs);
}
