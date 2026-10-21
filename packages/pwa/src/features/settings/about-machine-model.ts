/**
 * THE WORDS SETTINGS › MACHINE › ABOUT SAYS, decided from the daemon's `DaemonUpdateView` alone.
 *
 * Pure, so every sentence is asserted without a DOM. The contract is `docs/updating.md`: the daemon
 * decides HOW it was installed and WHAT updating takes; this file only chooses the words a person reads
 * for each of those answers, and never re-derives either.
 */

import {
  compareProtocolVersions,
  type DaemonUpdateView,
  describeInstallMethod,
  INSTALL_METHOD_LABELS,
  knownLatestRelease,
  type LatestRelease,
  type UpdateCheck,
  type UpdateJob,
} from '@ferretry/protocol';

/** "5 minutes ago": how old a check is, in the coarsest unit that is still honest. */
export function ageWords(at: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(at));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'} ago`;
}

/** The headline: is there something newer, and from what to what. */
export function updateHeadline(view: DaemonUpdateView): string {
  const latest = knownLatestRelease(view.check);
  if (view.available && latest !== undefined) return `Update available ${view.current} → ${latest.version}`;
  if (latest === undefined) return `Version ${view.current}`;
  return `Up to date — version ${view.current}`;
}

/** How the machine was installed: the short label, then the detail that lets a person recognise it. */
export const installWords = (view: DaemonUpdateView): { readonly label: string; readonly detail: string } => ({
  label: INSTALL_METHOD_LABELS[view.method.kind],
  detail: describeInstallMethod(view.method),
});

/** When the latest release was last asked for, and what came of it. */
export function checkWords(check: UpdateCheck, now: number): string {
  if (check.state === 'never') return 'This machine has not checked for a newer release yet.';
  if (check.state === 'ok') return `Latest release ${check.latest.version}, checked ${ageWords(check.checkedAt, now)}.`;
  const kept =
    check.lastKnown === undefined
      ? ''
      : ` The last answer, ${ageWords(check.lastKnown.checkedAt, now)}, said ${check.lastKnown.latest.version}.`;
  return `The last check, ${ageWords(check.checkedAt, now)}, failed: ${check.reason}.${kept}`;
}

/** The release whose page is the changelog, when one is known. */
export const changelogRelease = (view: DaemonUpdateView): LatestRelease | undefined => knownLatestRelease(view.check);

/** "1 ferret is" / "3 ferrets are". */
export const midTurnWords = (count: number): string =>
  count === 1 ? '1 ferret is mid-turn' : `${String(count)} ferrets are mid-turn`;

/**
 * The one line beside Update while ferrets are mid-turn. Updating no longer interrupts them: they run
 * outside the daemon, and their Ferretry calls wait for it to come back (docs/updating.md).
 */
export const keepRunningWords = (count: number): string =>
  `${midTurnWords(count)}. ${count === 1 ? 'It keeps' : 'They keep'} running while the machine restarts.`;

export type JobTone = 'ok' | 'warn' | 'err' | 'pend';

/** The update in flight, or the last one, as one sentence and a tone. */
export function jobWords(job: UpdateJob): { readonly tone: JobTone; readonly text: string } {
  switch (job.state) {
    case 'waiting-for-idle':
      return {
        tone: 'pend',
        text: `Waiting to update to ${job.target}: ${midTurnWords(job.midTurn)}. It starts when they are idle.`,
      };
    case 'running':
      return { tone: 'pend', text: `Updating to ${job.target} — the machine restarts and comes back on its own.` };
    case 'finished': {
      const tone: JobTone =
        job.report.outcome === 'succeeded' ? 'ok' : job.report.outcome === 'rolled-back' ? 'warn' : 'err';
      return { tone, text: job.report.message };
    }
  }
}

/** Whether the panel should keep asking: an update is running or waiting, so the machine will change. */
export const shouldPoll = (view: DaemonUpdateView): boolean => view.job !== null && view.job.state !== 'finished';

/**
 * The app's own version beside the machine's, and whether they disagree.
 *
 * A different version is a different protocol here (`version-skew.ts`), so any difference warns. A
 * build that does not know its own version says so rather than claiming they match.
 */
export function versionPairWords(
  appVersion: string | undefined,
  daemonVersion: string,
): { readonly tone: 'ok' | 'warn' | 'pend'; readonly text: string } {
  if (appVersion === undefined)
    return {
      tone: 'pend',
      text: `This copy of the app does not know its own version; the machine is ${daemonVersion}.`,
    };
  if (appVersion === daemonVersion) return { tone: 'ok', text: `App and machine are both ${daemonVersion}.` };
  const comparison = compareProtocolVersions(appVersion, daemonVersion);
  const advice =
    comparison === 1
      ? 'The machine is older — update it so every screen works.'
      : comparison === -1
        ? 'The app is older — reload it to pick up the new version.'
        : 'They are different builds.';
  return { tone: 'warn', text: `App ${appVersion}, machine ${daemonVersion}: the versions differ. ${advice}` };
}

/** The fields of a client error this reads; `FyHttpError` has both. */
interface ErrorLike {
  readonly status?: unknown;
  readonly message?: unknown;
}

/** A refused Update or setting, as the daemon's own sentence. */
export function refusalWords(cause: unknown): string {
  const error = (typeof cause === 'object' && cause !== null ? cause : {}) as ErrorLike;
  return typeof error.message === 'string' ? error.message : String(cause);
}

/** Whether a read failed because the machine has no update route yet: an older daemon, not a fault. */
export const isMissingRoute = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && (cause as ErrorLike).status === 404;
