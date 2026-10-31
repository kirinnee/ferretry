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

import type {
  FleetBudgetLevel,
  FleetBudgetPeriodView,
  FleetCredentialBudget,
  FleetCredentialList,
  FleetCredentialUsageWindow,
  FleetCredentialView,
} from '@ferretry/protocol';
import { HARNESS_NAMES } from '../components/component-model.ts';
import { timeUntil } from '../harness-login-model.ts';

export type HarnessKind = FleetCredentialView['harness'];

export const HARNESSES: readonly HarnessKind[] = ['claude', 'codex'];

/** The short names used in "Claude settings will be skipped on Codex". */
export const HARNESS_SHORT: Readonly<Record<HarnessKind, string>> = { claude: 'Claude', codex: 'Codex' };

/** The command a person types in their own terminal. */
export const HARNESS_COMMANDS: Readonly<Record<HarnessKind, string>> = { claude: 'claude', codex: 'codex' };

export const otherHarness = (harness: HarnessKind): HarnessKind => (harness === 'claude' ? 'codex' : 'claude');

/**
 * Every CLI a login drives, Claude Code first: both for an environment login with a `claude:` and a
 * `codex:` half, else its one (docs/provider-presets.md). A daemon that predates halves sends none.
 */
export const credentialHarnesses = (credential: FleetCredentialView): readonly HarnessKind[] =>
  credential.harnesses ?? [credential.harness];

/** A scope as the chip says it: one CLI, or `both`. */
export type LoginScope = HarnessKind | 'both';

/** Which CLIs a list of harnesses covers, as one scope. An empty list cannot happen; it reads as Claude. */
export const scopeOfHarnesses = (harnesses: readonly HarnessKind[]): LoginScope =>
  harnesses.includes('claude') && harnesses.includes('codex') ? 'both' : (harnesses[0] ?? 'claude');

/** The scope chip's words. */
export const LOGIN_SCOPE_WORDS: Readonly<Record<LoginScope, string>> = {
  claude: 'Claude only',
  codex: 'Codex only',
  both: 'Claude + Codex',
};

/** "Claude Code", or "Claude Code + Codex" for a login that drives both. */
export const harnessesName = (harnesses: readonly HarnessKind[]): string =>
  harnesses.map(harness => HARNESS_NAMES[harness]).join(' + ');

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/**
 * "you@example.com", or "Claude Code login" when the harness has not told us the email yet ("Claude Code +
 * Codex login" for one that drives both).
 */
export const credentialEmail = (credential: FleetCredentialView): string =>
  credential.email ?? `${harnessesName(credentialHarnesses(credential))} login`;

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

/**
 * The logins that can run one CLI, in the order the daemon listed them: a login with a half for it — so
 * a login that drives both is offered for either.
 */
export const credentialsOf = (list: FleetCredentialList, harness: HarnessKind): readonly FleetCredentialView[] =>
  list.credentials.filter(credential => credentialHarnesses(credential).includes(harness));

/** One group of the Credentials tab: the logins of one CLI, or the ones that drive both. */
export interface CredentialGroup {
  readonly scope: LoginScope;
  readonly title: string;
  readonly credentials: readonly FleetCredentialView[];
}

/**
 * The Credentials tab's groups, each login listed ONCE: Claude Code, Codex, then "Claude Code + Codex"
 * for the logins that drive both. An empty group is left out.
 */
export const credentialGroups = (list: FleetCredentialList): readonly CredentialGroup[] =>
  (['claude', 'codex', 'both'] as const)
    .map(scope => ({
      scope,
      title: scope === 'both' ? harnessesName(HARNESSES) : HARNESS_NAMES[scope],
      credentials: list.credentials.filter(credential => scopeOfHarnesses(credentialHarnesses(credential)) === scope),
    }))
    .filter(group => group.credentials.length > 0);

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

// ── Budgets (docs/budgets.md) ─────────────────────────────────────────────────────────────────────

/** `$12.40` — two decimals, as a bill reads. */
export const usdWords = (amount: number): string => `$${amount.toFixed(2)}`;

/**
 * `resets Sat` — a reset in the zone the budget is counted in, never the reader's. A budget resets at local
 * midnight, so the time is said only when it is not midnight (a zone whose clocks skip it): `resets Sun 01:00`.
 */
export const budgetResetWords = (resetsAt: string, zone: string): string =>
  `resets ${new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(Date.parse(resetsAt))
    .replace(/ 00:00$/u, '')}`;

/**
 * The two periods, as a meter labels them: short enough for the label column the 5h/Week quota bars use, so
 * a login's budget bars start and end exactly where its quota bars do, and marked as money beside them.
 */
const BUDGET_PERIOD_LABELS = { daily: '$/day', weekly: '$/week' } as const;
type BudgetPeriodKey = keyof typeof BUDGET_PERIOD_LABELS;

/**
 * How far past the higher limit a budget bar reaches. A fifth beyond it keeps the hard limit's mark INSIDE
 * the bar, where it can be seen: a mark at the very end of a clipped bar is a mark nobody sees.
 */
const BUDGET_BAR_HEADROOM = 1.2;

/** One period of a budget, as the meter draws it. */
export interface BudgetMeterRow {
  /** "$/day", "$/week". */
  readonly label: string;
  /** "$12.40 of $40.00 · resets Sat". */
  readonly words: string;
  /** The spend as a whole percent of the bar, which reaches a fifth past the higher limit. */
  readonly fillPercent: number;
  /** The trigger on that same scale, when the period has one. */
  readonly triggerPercent: number | null;
  /** The hard limit on that same scale, when the period has one. */
  readonly hardPercent: number | null;
  readonly level: FleetBudgetLevel;
}

const meterRow = (period: BudgetPeriodKey, view: FleetBudgetPeriodView, zone: string): BudgetMeterRow => {
  // A period always has at least one of the two levels; the bar reaches a fifth past the higher one.
  const scale = Math.max(view.trigger ?? 0, view.hard ?? 0) * BUDGET_BAR_HEADROOM;
  const percent = (amount: number): number => Math.min(100, Math.round((amount / scale) * 100));
  const ofWords =
    view.trigger === undefined ? `of ${usdWords(view.hard as number)} hard` : `of ${usdWords(view.trigger)}`;
  return {
    label: BUDGET_PERIOD_LABELS[period],
    words: `${usdWords(view.spentUsd)} ${ofWords} · ${budgetResetWords(view.resetsAt, zone)}`,
    fillPercent: percent(view.spentUsd),
    triggerPercent: view.trigger === undefined ? null : percent(view.trigger),
    hardPercent: view.hard === undefined ? null : percent(view.hard),
    level: view.level,
  };
};

/** A budget's periods, one bar each, in the order they reset: today, then this week. */
export const budgetMeterRows = (budget: FleetCredentialBudget): readonly BudgetMeterRow[] =>
  (Object.keys(BUDGET_PERIOD_LABELS) as readonly BudgetPeriodKey[]).flatMap(period =>
    budget[period] === undefined ? [] : [meterRow(period, budget[period] as FleetBudgetPeriodView, budget.timeZone)],
  );

/** The badge a budget holds a login under, or `null` while it is within every one of its budgets. */
export const budgetChip = (
  budget: FleetCredentialBudget | undefined,
): { readonly label: string; readonly tone: 'warn' | 'err' } | null => {
  if (budget === undefined || budget.level === 'ok') return null;
  // The words are the two holds of docs/budgets.md: what each level stops.
  return budget.level === 'over_hard'
    ? { label: 'Hard limit — ferrets stopped', tone: 'err' }
    : { label: 'Over budget — not routing', tone: 'warn' };
};

/**
 * What the spend IS and IS NOT, under the bars: this machine's only, the requests no price covers,
 * and whether the meter has counted this login's sessions yet.
 */
export const budgetScopeNote = (budget: FleetCredentialBudget, machineName: string): string =>
  [
    `Spent on ${machineName} only`,
    ...(budget.unpriced > 0 ? [`${plural(budget.unpriced, 'request')} without a price`] : []),
    ...(budget.measured ? [] : ['Counting…']),
    // A transcript too large to read back to the period's start: what came before is not in the amount.
    ...(budget.partial === true ? ['may be low: a transcript is too large to read in full'] : []),
  ].join(' · ');

/**
 * Where a budget's days are counted, and where THAT comes from: the zone `machine.yaml` names, or
 * this machine's own — which is what saving from here replaces with `deviceZone` (docs/budgets.md).
 */
export const budgetZoneWords = (budget: FleetCredentialBudget | undefined, deviceZone: string): string => {
  if (budget === undefined)
    return `Days reset at midnight, weeks on Monday — counted in your zone (${deviceZone}) once you save; it is written to machine.yaml.`;
  return budget.timeZoneSet
    ? `Days reset at midnight, weeks on Monday, in ${budget.timeZone} (written in machine.yaml).`
    : `Days reset at midnight, weeks on Monday, in ${budget.timeZone} — this machine’s own zone. Saving here writes yours (${deviceZone}).`;
};

/** One level of the editor: the text of a dollar amount, empty for no limit. */
export interface BudgetDraft {
  readonly dailyTrigger: string;
  readonly dailyHard: string;
  readonly weeklyTrigger: string;
  readonly weeklyHard: string;
}

/** A budget as it is written to the login's file: one or two periods, each with at least one level. */
export interface BudgetLimits {
  readonly daily?: { readonly trigger?: number; readonly hard?: number };
  readonly weekly?: { readonly trigger?: number; readonly hard?: number };
}

const amountText = (amount: number | undefined): string => (amount === undefined ? '' : String(amount));

/** The editor's fields from the budget the daemon last reported; all empty when there is none. */
export const budgetDraft = (budget: FleetCredentialBudget | undefined): BudgetDraft => ({
  dailyTrigger: amountText(budget?.daily?.trigger),
  dailyHard: amountText(budget?.daily?.hard),
  weeklyTrigger: amountText(budget?.weekly?.trigger),
  weeklyHard: amountText(budget?.weekly?.hard),
});

/** A field's dollars: `undefined` when empty, `NaN` when it is not a positive amount. Takes a `$`. */
export const parseBudgetAmount = (text: string): number | undefined => {
  const trimmed = text.trim().replace(/^\$/u, '');
  if (trimmed === '') return undefined;
  const amount = Number(trimmed);
  return Number.isFinite(amount) && amount > 0 ? amount : Number.NaN;
};

/**
 * One period of a draft as typed numbers, `undefined` where a field is empty. A field that is not a
 * positive amount stays `NaN` here; {@link budgetDraftProblem} is what says it cannot be saved.
 */
const draftLevels = (
  draft: BudgetDraft,
  period: BudgetPeriodKey,
): { readonly trigger?: number; readonly hard?: number } => {
  const trigger = parseBudgetAmount(period === 'daily' ? draft.dailyTrigger : draft.weeklyTrigger);
  const hard = parseBudgetAmount(period === 'daily' ? draft.dailyHard : draft.weeklyHard);
  if (trigger === undefined && hard === undefined) return {};
  return { ...(trigger === undefined ? {} : { trigger }), ...(hard === undefined ? {} : { hard }) };
};

/** Why the editor cannot save this draft, or `null` when it can. All four empty is a removal, not a problem. */
export const budgetDraftProblem = (draft: BudgetDraft): string | null => {
  for (const period of ['daily', 'weekly'] as const) {
    const { trigger, hard } = draftLevels(draft, period);
    if (trigger !== undefined && Number.isNaN(trigger)) return 'Give every limit as dollars above 0, like 40 or 12.50.';
    if (hard !== undefined && Number.isNaN(hard)) return 'Give every limit as dollars above 0, like 40 or 12.50.';
    if (trigger !== undefined && hard !== undefined && hard < trigger)
      return `The ${period} hard limit must not be below its trigger.`;
  }
  return null;
};

/** The draft as the login's `budget` key: `undefined` removes the budget, an empty period leaves it out. */
export const budgetOfDraft = (draft: BudgetDraft): BudgetLimits | undefined => {
  const daily = draftLevels(draft, 'daily');
  const weekly = draftLevels(draft, 'weekly');
  const empty = (levels: { readonly trigger?: number; readonly hard?: number }): boolean =>
    levels.trigger === undefined && levels.hard === undefined;
  return empty(daily) && empty(weekly)
    ? undefined
    : { ...(empty(daily) ? {} : { daily }), ...(empty(weekly) ? {} : { weekly }) };
};

/** A budget view as `budgetOfDraft` would write it, so a draft can be compared with what is in effect. */
export const budgetLimitsOfView = (budget: FleetCredentialBudget | undefined): BudgetLimits | undefined =>
  budget === undefined ? undefined : budgetOfDraft(budgetDraft(budget));

/** Whether the draft differs from the budget the daemon last reported. */
export const budgetDraftChanged = (draft: BudgetDraft, budget: FleetCredentialBudget | undefined): boolean =>
  JSON.stringify(budgetOfDraft(draft) ?? null) !== JSON.stringify(budgetLimitsOfView(budget) ?? null);
