/**
 * What the Credentials tab SAYS — the pure half (docs/design/account-model.md §3.2, §4.2, §4.6).
 *
 * The daemon owns the facts: the status word and its sentence, the usage windows, who uses a login and
 * what signing it out would do. This module owns only the prose around them, so every sentence a person
 * reads is pinned by a test, and two screens cannot word one login two ways.
 *
 * Three rules from the design run through it:
 *
 * - **A login is named by its email and its label** ("you@example.com (work)"), never by an id or a
 *   folder (§4.1 rule 8).
 * - **Unknown is never zero.** A usage window nobody measured is "Not measured yet", not an empty bar.
 * - **Signing in or out says how many runtimes it changes** (C7, E31).
 */

import type { FleetCredentialList, FleetCredentialUsageWindow, FleetCredentialView } from '@ferretry/protocol';
import { timeUntil } from '../harness-login-model.ts';

export type HarnessKind = FleetCredentialView['harness'];

export const HARNESSES: readonly HarnessKind[] = ['claude', 'codex'];

/** The product names. */
export const HARNESS_NAMES: Readonly<Record<HarnessKind, string>> = { claude: 'Claude Code', codex: 'Codex' };

/** The short names used in "Claude settings will be skipped on Codex". */
export const HARNESS_SHORT: Readonly<Record<HarnessKind, string>> = { claude: 'Claude', codex: 'Codex' };

/** The command a person types in their own terminal. */
export const HARNESS_COMMANDS: Readonly<Record<HarnessKind, string>> = { claude: 'claude', codex: 'codex' };

export const otherHarness = (harness: HarnessKind): HarnessKind => (harness === 'claude' ? 'codex' : 'claude');

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** "you@example.com", or "Claude Code login" when the harness has not told us the email yet. */
export const credentialEmail = (credential: FleetCredentialView): string =>
  credential.email ?? `${HARNESS_NAMES[credential.harness]} login`;

/** "you@example.com (work)": how a login is named everywhere. */
export const credentialName = (credential: FleetCredentialView): string =>
  credential.label === undefined ? credentialEmail(credential) : `${credentialEmail(credential)} (${credential.label})`;

/** "Used by 3 runtimes" or "Not used yet". */
export const credentialUse = (credential: FleetCredentialView): string =>
  credential.usedBy.length === 0 ? 'Not used yet' : `Used by ${plural(credential.usedBy.length, 'runtime')}`;

/** "Shared with claude in your terminal" for a login kept in the person's own store (C4). */
export const terminalBadge = (credential: FleetCredentialView): string | null =>
  credential.sharedWithTerminal ? `Shared with ${HARNESS_COMMANDS[credential.harness]} in your terminal` : null;

/** "Copied slot from studio-mac" for an empty slot a clone made (C8). */
export const slotBadge = (credential: FleetCredentialView): string | null =>
  credential.clonedFrom === undefined ? null : `Copied slot from ${credential.clonedFrom}`;

/** The sentence under the status on a login's page. */
export const credentialExplanation = (credential: FleetCredentialView): string => {
  if (credential.status.word === 'needs_sign_in' && credential.clonedFrom !== undefined)
    return `Empty slot. It was copied from ${credential.clonedFrom} without the login itself. Sign in once and every runtime that uses it can launch.`;
  return credential.status.explanation;
};

/** The sign-in button: "Finish sign-in for 3 runtimes" when one sign-in fixes several (E31). */
export const finishSignInLabel = (credential: FleetCredentialView): string =>
  credential.usedBy.length > 1 ? `Finish sign-in for ${String(credential.usedBy.length)} runtimes` : 'Finish sign-in';

/** What a sign-in covers, in the panel's header note. */
export const signInCoverage = (credential: FleetCredentialView, machineName: string): string =>
  credential.usedBy.length === 0
    ? `The login is kept on ${machineName}. Nothing uses it yet.`
    : `The login is kept on ${machineName}. Every runtime that uses it (${plural(credential.usedBy.length, 'runtime')}) can launch once it is done.`;

/** After a sign-in: "Signed in. 3 runtimes can launch now." (E31). */
export const signedInSentence = (count: number): string =>
  count === 0 ? 'Signed in.' : `Signed in. ${plural(count, 'runtime')} can launch now.`;

export interface UsageBar {
  /** "5h", "Week". */
  readonly label: string;
  /** Whole percent used; `null` when nothing measured it. */
  readonly percent: number | null;
  /** "resets in 2h", or `null`. */
  readonly resets: string | null;
  /** Spent enough that the bar is drawn as a warning. */
  readonly high: boolean;
}

const bar = (label: string, window: FleetCredentialUsageWindow, nowMs: number): UsageBar => {
  const percent = window.usedPercent === undefined ? null : Math.min(100, Math.round(window.usedPercent));
  const left = timeUntil(window.resetsAt, nowMs);
  const resets = left === null ? null : left === 'now' ? 'resets now' : `resets in ${left}`;
  return { label, percent, resets, high: percent !== null && percent >= 80 };
};

/** The two windows, or `null` when neither was measured (then the page says so in words). */
export const usageBars = (credential: FleetCredentialView, nowMs: number): readonly UsageBar[] | null => {
  const bars = [bar('5h', credential.usage.fiveHour, nowMs), bar('Week', credential.usage.weekly, nowMs)];
  return bars.every(candidate => candidate.percent === null) ? null : bars;
};

/** One bar as a phrase whose direction cannot be misread. */
export const usageBarText = (usage: UsageBar): string =>
  usage.percent === null
    ? `${usage.label}: not measured yet`
    : `${usage.label}: ${String(usage.percent)}% used${usage.resets === null ? '' : ` · ${usage.resets}`}`;

/** Logins of one harness, in the order the daemon listed them. */
export const credentialsOf = (list: FleetCredentialList, harness: HarnessKind): readonly FleetCredentialView[] =>
  list.credentials.filter(credential => credential.harness === harness);

/** Whether two logins of one harness share an email, so the tab explains the labels. */
export const hasSharedEmails = (list: FleetCredentialList): boolean =>
  list.credentials.some(credential => credential.needsLabel) ||
  HARNESSES.some(harness => {
    const emails = credentialsOf(list, harness).flatMap(credential =>
      credential.email === undefined ? [] : [credential.email],
    );
    return new Set(emails).size !== emails.length;
  });

/** Another login of this harness with the same email (E26), the one the label step asks about. */
export const sameEmailLogin = (
  list: FleetCredentialList,
  credential: FleetCredentialView,
): FleetCredentialView | undefined =>
  credential.email === undefined
    ? undefined
    : list.credentials.find(
        other => other.id !== credential.id && other.harness === credential.harness && other.email === credential.email,
      );

/** Whether the two labels of the E26 step can be saved: both given, and different. */
export const labelsError = (older: string, newer: string): string | null => {
  if (older.trim() === '' || newer.trim() === '') return 'Give each login a label.';
  return older.trim() === newer.trim() ? 'Use two different labels.' : null;
};

/** A new login's id: the harness name, numbered past every id this machine already has. */
export const nextCredentialId = (list: FleetCredentialList | null, harness: HarnessKind): string => {
  const taken = new Set((list?.credentials ?? []).map(credential => credential.id));
  let index = 2;
  while (taken.has(`${harness}-${String(index)}`)) index += 1;
  return taken.has(harness) ? `${harness}-${String(index)}` : harness;
};
