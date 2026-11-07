/**
 * THE WORDS SETTINGS › MACHINE › AGENT CLIs SAYS, decided from the daemon's `HarnessUpdateView` alone.
 *
 * Pure, so every sentence is asserted without a DOM. The daemon decides where each harness is, how it
 * was installed, what updating takes and what Ferretry verified (`docs/updating.md`); this file only
 * chooses the words and the buttons for each of those answers, and never re-derives one.
 */

import {
  describeHarnessInstall,
  HARNESS_CLI_LABELS,
  HARNESS_UPDATE_CODES,
  type HarnessCliLocation,
  type HarnessCliView,
  type HarnessUpdateJob,
  HarnessUpdateUnverifiedBodySchema,
  type HarnessUpdateView,
  type HarnessVerification,
  harnessInstallLabel,
  harnessUpdateTargets,
  installedHarnessVersion,
  needsUnverifiedConsent,
  type UpdateCheck,
} from '@ferretry/protocol';
import { ageWords, type JobTone } from './about-machine-model.ts';

/** The badge beside a harness's version: where it stands against what Ferretry verified. */
export function verificationBadge(verification: HarnessVerification): {
  readonly tone: 'ok' | 'warn' | 'pend';
  readonly text: string;
} {
  switch (verification) {
    case 'verified':
      return { tone: 'ok', text: 'Verified by Ferretry' };
    case 'older':
      return { tone: 'pend', text: 'Older than verified' };
    case 'unverified':
      return { tone: 'warn', text: 'Not yet verified by Ferretry' };
    case 'unknown':
      return { tone: 'pend', text: 'Version unknown' };
  }
}

/** The harness and the version it runs, as the card's heading says it. */
export function cliHeadline(view: HarnessCliView): string {
  const label = HARNESS_CLI_LABELS[view.harness];
  if (view.location.state !== 'located') return label;
  return `${label} ${installedHarnessVersion(view) ?? '(version unreadable)'}`;
}

/** Which file runs, and why it is that one — or why there is none. */
export function locationWords(location: HarnessCliLocation): string {
  if (location.state === 'located') return `${location.rule} (${location.declaredBy})`;
  if (location.state === 'override-absent') return location.reason;
  return location.searched.length === 0
    ? 'Not found on this daemon’s PATH.'
    : `Not found on this daemon’s PATH or in ${location.searched.join(', ')}.`;
}

/** How it was installed: the short label, then the detail that lets a person recognise it. */
export function installWords(view: HarnessCliView): { readonly label: string; readonly detail: string } | undefined {
  if (view.method === null) return undefined;
  return { label: harnessInstallLabel(view.method), detail: describeHarnessInstall(view.method) };
}

/** The newest version, when it was asked for, and what came of it. */
export function latestWords(check: UpdateCheck, now: number): string {
  if (check.state === 'never') return 'Not checked yet.';
  if (check.state === 'ok') return `${check.latest.version} on npm, checked ${ageWords(check.checkedAt, now)}.`;
  const kept =
    check.lastKnown === undefined
      ? ''
      : ` The last answer, ${ageWords(check.lastKnown.checkedAt, now)}, said ${check.lastKnown.latest.version}.`;
  return `The check ${ageWords(check.checkedAt, now)} failed: ${check.reason}.${kept}`;
}

/** The update running or the last one, as one sentence and a tone. */
export function cliJobWords(job: HarnessUpdateJob): { readonly tone: JobTone; readonly text: string } {
  if (job.state === 'running') return { tone: 'pend', text: `Updating — running ${job.command}` };
  const tone: JobTone = job.report.outcome === 'succeeded' ? 'ok' : job.report.outcome === 'failed' ? 'err' : 'warn';
  return { tone, text: job.report.message };
}

/** One button an Update offers. `target` absent is "the newest this method has". */
export interface UpdateChoice {
  readonly key: string;
  readonly target?: string;
  readonly label: string;
  /** Going past what Ferretry verified, which needs the person's explicit yes first. */
  readonly unverified: boolean;
  readonly primary: boolean;
}

/**
 * The buttons for one harness. A method that installs a chosen version is offered the verified one
 * (primary) and the newest; one that takes what it has gets a single Update, flagged unverified when the
 * newest — or an unknown — is past what Ferretry verified.
 */
export function updateChoices(view: HarnessCliView): readonly UpdateChoice[] {
  if (view.plan?.kind !== 'self' || !view.available) return [];
  const targets = harnessUpdateTargets(view);
  if (!view.plan.pinsVersion) {
    const unverified = targets.latest === undefined || needsUnverifiedConsent(view.harness, targets.latest);
    return [{ key: 'newest', label: 'Update', unverified, primary: !unverified }];
  }
  const choices: UpdateChoice[] = [];
  if (targets.verified !== undefined)
    choices.push({
      key: 'verified',
      target: targets.verified,
      label: `Update to ${targets.verified} (verified)`,
      unverified: false,
      primary: true,
    });
  if (targets.latest !== undefined) {
    const unverified = needsUnverifiedConsent(view.harness, targets.latest);
    choices.push({
      key: 'latest',
      target: targets.latest,
      label: `Update to ${targets.latest}`,
      unverified,
      primary: choices.length === 0 && !unverified,
    });
  }
  return choices;
}

/** The sentence the confirm box asks with. */
export function unverifiedQuestion(view: HarnessCliView, target: string | undefined): string {
  const label = HARNESS_CLI_LABELS[view.harness];
  return target === undefined
    ? `Ferretry cannot tell which ${label} version this installs, so it may be one Ferretry has not verified yet. Ferretry verified ${view.verified.version}.`
    : `${label} ${target} has not been verified by Ferretry yet. Ferretry verified ${view.verified.version}; a newer version can change how Ferretry drives it.`;
}

/** Whether the panel should keep asking: an update is running, so the machine will change. */
export const shouldPollClis = (view: HarnessUpdateView): boolean =>
  view.harnesses.some(harness => harness.job?.state === 'running');

/** Whether any harness has something newer — the Machines list's dot. */
export const anyCliUpdate = (view: HarnessUpdateView): boolean => view.harnesses.some(harness => harness.available);

/** What an Update press came back with, when it was not the new view. */
export type CliStartRefusal =
  | { readonly kind: 'unverified'; readonly target?: string; readonly verified: string }
  | { readonly kind: 'message'; readonly text: string };

interface ErrorLike {
  readonly code?: unknown;
  readonly body?: unknown;
  readonly message?: unknown;
}

/** Turns a refused Update into the confirm it needs, or the daemon's own sentence. */
export function cliStartRefusal(cause: unknown): CliStartRefusal {
  const error = (typeof cause === 'object' && cause !== null ? cause : {}) as ErrorLike;
  if (error.code === HARNESS_UPDATE_CODES.unverified) {
    const body = HarnessUpdateUnverifiedBodySchema.safeParse(error.body);
    if (body.success)
      return {
        kind: 'unverified',
        verified: body.data.verified,
        ...(body.data.target === undefined ? {} : { target: body.data.target }),
      };
  }
  return { kind: 'message', text: typeof error.message === 'string' ? error.message : String(cause) };
}
