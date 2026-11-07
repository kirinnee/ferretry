/**
 * What the Sign-ins tab SAYS — the pure half (docs/design/account-model.md §3.2, §4.2, §4.6).
 *
 * The daemon owns the facts: the status word and its sentence, the usage windows, who uses a login and what signing it
 * out would do. This module owns only the prose around them, so every sentence a person reads is pinned by a test, and
 * two screens cannot word one login two ways.
 *
 * - **A login is named by its email and its label** ("you@example.com (work)"), never by an id or a folder.
 * - **Unknown is never zero.** A usage window nobody measured is "Not measured yet", not an empty bar.
 * - **Signing in says how many runtimes it changes.**
 */

import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { LoginList, LoginUsageWindow, LoginView } from '../../contract/index.ts';
import { timeUntil } from './harness-login-model.ts';

export type HarnessKind = HarnessKey;

export const HARNESSES: readonly HarnessKind[] = ['claude-code', 'codex'];

/** A harness's name as a person reads it. */
export const HARNESS_NAMES: Readonly<Record<HarnessKind, string>> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** The command a person types in their own terminal. */
export const HARNESS_COMMANDS: Readonly<Record<HarnessKind, string>> = { 'claude-code': 'claude', codex: 'codex' };

/** Every CLI a login drives, Claude Code first: both for an environment login with a `claude-code:` and a `codex:` half. */
export const loginHarnesses = (login: LoginView): readonly HarnessKind[] => login.harnesses;

/** A scope as the chip says it: one CLI, or `both`. */
export type LoginScope = HarnessKind | 'both';

/** Which CLIs a list of harnesses covers, as one scope. An empty list cannot happen; it reads as Claude. */
export const scopeOfHarnesses = (harnesses: readonly HarnessKind[]): LoginScope =>
  harnesses.includes('claude-code') && harnesses.includes('codex') ? 'both' : (harnesses[0] ?? 'claude-code');

/** The scope chip's words. */
export const LOGIN_SCOPE_WORDS: Readonly<Record<LoginScope, string>> = {
  'claude-code': 'Claude only',
  codex: 'Codex only',
  both: 'Claude + Codex',
};

/** "Claude Code", or "Claude Code + Codex" for a login that drives both. */
export const harnessesName = (harnesses: readonly HarnessKind[]): string =>
  harnesses.map(harness => HARNESS_NAMES[harness]).join(' + ');

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** "you@example.com", or "Claude Code login" when the harness has not told us the email yet. */
export const loginEmail = (login: LoginView): string => login.email ?? `${harnessesName(loginHarnesses(login))} login`;

/** "you@example.com (work)": how a login is named everywhere. */
export const loginName = (login: LoginView): string =>
  login.label === undefined ? loginEmail(login) : `${loginEmail(login)} (${login.label})`;

/** "Used by 3 runtimes" or "Not used yet". */
export const loginUse = (login: LoginView): string =>
  login.usedBy.length === 0 ? 'Not used yet' : `Used by ${plural(login.usedBy.length, 'runtime')}`;

/** "Shared with claude in your terminal" for a login kept in the person's own store. */
export const terminalBadge = (login: LoginView): string | null =>
  login.sharedWithTerminal ? `Shared with ${HARNESS_COMMANDS[login.harness]} in your terminal` : null;

/** "Copied slot from studio-mac" for an empty slot a clone made. */
export const slotBadge = (login: LoginView): string | null =>
  login.clonedFrom === undefined ? null : `Copied slot from ${login.clonedFrom}`;

/** The sentence under the status on a login's page. */
export const loginExplanation = (login: LoginView): string => {
  if (login.status.word === 'needs_sign_in' && login.clonedFrom !== undefined)
    return `Empty slot. It was copied from ${login.clonedFrom} without the login itself. Sign in once and every runtime that uses it can launch.`;
  return login.status.explanation;
};

/** The sign-in button: "Finish sign-in for 3 runtimes" when one sign-in fixes several. */
export const finishSignInLabel = (login: LoginView): string =>
  login.usedBy.length > 1 ? `Finish sign-in for ${String(login.usedBy.length)} runtimes` : 'Finish sign-in';

/** What a sign-in covers, in the panel's header note. */
export const signInCoverage = (login: LoginView, machineName: string): string =>
  login.usedBy.length === 0
    ? `The login is kept on ${machineName}. Nothing uses it yet.`
    : `The login is kept on ${machineName}. Every runtime that uses it (${plural(login.usedBy.length, 'runtime')}) can launch once it is done.`;

/** After a sign-in: "Signed in. 3 runtimes can launch now." */
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

const bar = (label: string, window: LoginUsageWindow, nowMs: number): UsageBar => {
  const percent = window.usedPercent === undefined ? null : Math.min(100, Math.round(window.usedPercent));
  const left = timeUntil(window.resetsAt, nowMs);
  const resets = left === null ? null : left === 'now' ? 'resets now' : `resets in ${left}`;
  return { label, percent, resets, high: percent !== null && percent >= 80 };
};

/** The two windows, or `null` when neither was measured (then the page says so in words). */
export const usageBars = (login: LoginView, nowMs: number): readonly UsageBar[] | null => {
  const bars = [bar('5h', login.usage.fiveHour, nowMs), bar('Week', login.usage.weekly, nowMs)];
  return bars.every(candidate => candidate.percent === null) ? null : bars;
};

/** One bar as a phrase whose direction cannot be misread. */
export const usageBarText = (usage: UsageBar): string =>
  usage.percent === null
    ? `${usage.label}: not measured yet`
    : `${usage.label}: ${String(usage.percent)}% used${usage.resets === null ? '' : ` · ${usage.resets}`}`;

/** One group of the Sign-ins tab: the logins of one CLI, or the ones that drive both. */
export interface LoginGroup {
  readonly scope: LoginScope;
  readonly title: string;
  readonly logins: readonly LoginView[];
}

/**
 * The Sign-ins tab's groups, each login listed ONCE: Claude Code, Codex, then "Claude Code + Codex" for the logins
 * that drive both. An empty group is left out.
 */
export const loginGroups = (list: LoginList): readonly LoginGroup[] =>
  (['claude-code', 'codex', 'both'] as const)
    .map(scope => ({
      scope,
      title: scope === 'both' ? harnessesName(HARNESSES) : HARNESS_NAMES[scope],
      logins: list.logins.filter(login => scopeOfHarnesses(loginHarnesses(login)) === scope),
    }))
    .filter(group => group.logins.length > 0);

/** Whether two logins of one harness share an email, so the tab explains the labels. */
export const hasSharedEmails = (list: LoginList): boolean =>
  list.logins.some(login => login.needsLabel) ||
  HARNESSES.some(harness => {
    const emails = list.logins
      .filter(login => loginHarnesses(login).includes(harness))
      .flatMap(login => (login.email === undefined ? [] : [login.email]));
    return new Set(emails).size !== emails.length;
  });

/** The words an environment login's Test button and answer use. */
export const testNote = (act: {
  readonly available: boolean;
  readonly note?: string;
  readonly reason?: string;
}): string => (act.available ? (act.note ?? '') : (act.reason ?? ''));

/** The inline consent a one-token Test asks for. */
export const TEST_CONSENT =
  'This provider has no free check, so the Test sends one message capped at one token — a fraction of a cent. Send it?';

/** One Test answer, as the line under the button. */
export const testResultLine = (result: {
  readonly ok: boolean;
  readonly spent: string;
  readonly message: string;
}): string =>
  result.ok
    ? `Test passed${result.spent === 'one-token' ? ' — one token spent' : ' — nothing spent'}.`
    : result.message;
