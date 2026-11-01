/**
 * The Recent actions list as rows: one line each, grouped, filtered and paged. Pure — the tsx only draws.
 *
 * Two rules the rows keep:
 *   1. WHO ACTED is read through `wardenActionActor`, so an older daemon's actions still carry an actor.
 *   2. A REPEAT IS CONSECUTIVE. Three identical actions in a row are one `×3` row; the same action
 *      returning after something else happened is a new row, because the gap is itself news.
 *   3. EVERY JEV CHECK IS ON THE LIST. A check that cleared or acted is already an action; one Jev
 *      handed on — to an investigation or to the owner — or was not asked about because its cap was
 *      spent is a row of its own (`status.jevChecks`), so a day Jev looked at everything and settled
 *      nothing still shows Jev at work.
 */

import type {
  WardenAction,
  WardenActionKind,
  WardenActor,
  WardenAnomalyKind,
  WardenJevCheck,
  WardenJevCheckWhy,
  WardenOutcome,
  WardenStatusView,
} from '@ferretry/protocol';
import { displaySystemCallsign, wardenActionActor, wardenActionOutcome } from '@ferretry/protocol';
import { jevBeforeLine, jevCost } from './warden-jev-line.ts';
import { compactAgo, fullTime, optional, percent } from './warden-overview-model.ts';
import { ANOMALY_CHIPS, ACTOR_LABEL, chip, outcomeChip, type WardenChip } from './warden-vocabulary.ts';

export const ACTIONS_PAGE = 20;

export type ActorFilter = 'all' | 'auto' | 'jev' | 'llm';
/** `handed` is a Jev check that settled nothing: handed on, or skipped for the cap. */
export type OutcomeFilter = 'all' | WardenOutcome | 'handed';

export interface ActionFilters {
  readonly actor: ActorFilter;
  readonly outcome: OutcomeFilter;
}

export const NO_FILTERS: ActionFilters = { actor: 'all', outcome: 'all' };

export const ACTOR_FILTERS: readonly { readonly key: ActorFilter; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'auto', label: ACTOR_LABEL.auto },
  { key: 'jev', label: ACTOR_LABEL.jev },
  { key: 'llm', label: ACTOR_LABEL.llm },
];

export const OUTCOME_FILTERS: readonly { readonly key: OutcomeFilter; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'moved', label: 'Moved' },
  { key: 'cleared', label: 'Cleared' },
  { key: 'stopped', label: 'Stopped' },
  { key: 'asked', label: 'Asked' },
  { key: 'handed', label: 'Handed on' },
];

const VERB: Readonly<Record<WardenActionKind, string>> = {
  bless: 'Left alone',
  nudge: 'Nudged',
  resume: 'Resumed',
  revive: 'Revived',
  restart: 'Restarted',
  stop: 'Stopped',
  failover: 'Moved to another account',
  close_leftover: 'Closed a leftover browser',
};

/** One moment an action happened: the compact column text and the full time for its tooltip. */
interface ActionTime {
  readonly compact: string;
  readonly full: string;
}

export interface WardenActionRow {
  readonly key: string;
  readonly sessionId: string;
  /** Moved / Cleared / Stopped / Asked / Closed / Failed. */
  readonly chip: WardenChip;
  /** The specific verb — `Restarted`, `Nudged` — for the chip's tooltip and the expanded view. */
  readonly verb: string;
  readonly failed: boolean;
  readonly actor: WardenActor;
  /** `Auto`, `Jev 96%`, `LLM`, `You`. */
  readonly actorLabel: string;
  /** The investigator, `warden-00002A`, when an investigation acted. */
  readonly investigator?: string;
  readonly actorTitle: string;
  /** The one line the row shows. */
  readonly reason: string;
  /** Jev's own reason, when it adds to the line. */
  readonly jevReason?: string;
  readonly anomaly?: WardenChip;
  readonly anomalyKind?: WardenAnomalyKind;
  /** The account a failover moved to. */
  readonly failoverTo?: string;
  /** The account it left, when the Warden moved a ferret off a login that hit a limit. */
  readonly failoverFrom?: string;
  readonly reportPath?: string;
  /** How many identical actions this row stands for. */
  readonly count: number;
  /** Newest first. The first is the row's own time. */
  readonly times: readonly ActionTime[];
  readonly outcome: WardenOutcome | undefined;
  /** A Jev check that settled nothing, rather than an action. */
  readonly check?: 'handed_on' | 'skipped';
  /** What the check cost, `$0.0004`. Jev checks only. */
  readonly cost?: string;
  /** What Jev did before the investigation whose verdict this was (`warden-jev-line.ts`). LLM rows only. */
  readonly jev?: string;
}

const rowChip = (action: WardenAction, outcome: WardenOutcome | undefined): WardenChip =>
  action.outcome === 'failed'
    ? chip('Failed', 'err')
    : outcome === undefined
      ? chip('Closed', 'pend')
      : outcomeChip(outcome);

const rowFor = (action: WardenAction, now: number): WardenActionRow => {
  const actor = wardenActionActor(action);
  const outcome = wardenActionOutcome(action);
  const investigator = action.investigator === undefined ? undefined : displaySystemCallsign(action.investigator);
  const confidence = actor === 'jev' && action.confidence !== undefined ? ` ${percent(action.confidence)}` : '';
  const actorLabel = `${ACTOR_LABEL[actor]}${confidence}`;
  const jevReason = action.reason !== undefined && action.reason !== action.detail ? action.reason : undefined;
  return {
    key: `${action.sessionId}:${action.action}:${action.at}`,
    sessionId: action.sessionId,
    chip: rowChip(action, outcome),
    verb: VERB[action.action],
    failed: action.outcome === 'failed',
    actor,
    actorLabel,
    ...optional('investigator', investigator),
    actorTitle: investigator === undefined ? actorLabel : `${actorLabel} · ${investigator}`,
    reason: action.detail,
    ...optional('jevReason', jevReason),
    ...optional('anomaly', action.anomalyKind === undefined ? undefined : ANOMALY_CHIPS[action.anomalyKind]),
    ...optional('anomalyKind', action.anomalyKind),
    ...optional('failoverTo', action.agent),
    ...optional('failoverFrom', action.fromAgent),
    ...optional('reportPath', action.reportPath),
    ...optional('jev', actor === 'llm' ? jevBeforeLine(action.jev) : undefined),
    count: 1,
    times: [{ compact: compactAgo(action.at, now), full: fullTime(action.at) }],
    outcome,
  };
};

const sameRepeat = (left: WardenAction, right: WardenAction): boolean =>
  left.sessionId === right.sessionId &&
  left.action === right.action &&
  left.outcome === right.outcome &&
  wardenActionActor(left) === wardenActionActor(right) &&
  left.detail === right.detail;

// ── Jev's checks ─────────────────────────────────────────────────────────────────────────────

const ACT_VERB: Readonly<Record<NonNullable<WardenJevCheck['act']>, string>> = {
  nudge: 'nudge it',
  resume: 'resume it',
  restart: 'restart it',
  stop: 'stop it',
  failover: 'move it to another account',
};

const ACT_ALONE: Readonly<Record<NonNullable<WardenJevCheck['act']>, string>> = {
  nudge: 'nudging',
  resume: 'resuming',
  restart: 'restarting',
  stop: 'stopping',
  failover: 'moving accounts',
};

/** What Jev made of the flag, in a sentence that ends before where it went. */
const checkCause = (check: WardenJevCheck): string => {
  const sure = percent(check.confidence);
  const act = check.act === undefined ? undefined : ACT_VERB[check.act];
  const why: WardenJevCheckWhy | undefined = check.why;
  switch (why) {
    case 'jev_cap':
      return 'Jev was not asked: its daily cap is spent';
    case 'jev_paced':
      return 'Jev was not asked: this hour’s share of its cap is spent';
    case 'failed':
      return 'Jev’s check failed';
    case 'act_failed':
      return `Jev tried to ${act ?? 'act'} (${sure} sure) and it did not take`;
    case 'never_alone':
    case 'not_allowed':
      return check.act === undefined
        ? `Jev was ${sure} sure, but may not act alone`
        : `Jev would ${ACT_VERB[check.act]} (${sure} sure), but ${ACT_ALONE[check.act]} alone is off`;
    case 'cannot_choose_login':
      return `Jev would move it to another account (${sure} sure), but cannot choose which`;
    case 'not_sure_enough':
      return `Jev was only ${sure} sure${act === undefined ? '' : ` it should ${act}`}, below your bar`;
    case 'no_message':
      return 'Jev would nudge it, but was not sure enough of what to say';
    case 'already_acted':
      return 'Jev already acted on this and it is still flagged';
    case 'not_offered':
      return 'Jev chose something this flag does not allow';
    case 'unsure':
    case undefined:
      return `Jev was not sure (${sure})`;
  }
};

const checkReason = (check: WardenJevCheck): string =>
  `${checkCause(check)}, so ${check.route === 'owner' ? 'it waits for you' : 'it went to an investigation'}.`;

/** A check worth its own row: one that settled nothing. A healthy or acted check is already an action. */
const handedOn = (check: WardenJevCheck): check is WardenJevCheck & { readonly verdict: 'handed_on' | 'skipped' } =>
  check.verdict === 'handed_on' || check.verdict === 'skipped';

const checkRowFor = (
  check: WardenJevCheck & { readonly verdict: 'handed_on' | 'skipped' },
  now: number,
): WardenActionRow => {
  const skipped = check.verdict === 'skipped';
  const actorLabel = skipped ? ACTOR_LABEL.jev : `${ACTOR_LABEL.jev} ${percent(check.confidence)}`;
  return {
    key: `jev:${check.sessionId}:${check.anomalyKind}:${check.at}`,
    sessionId: check.sessionId,
    chip: skipped ? chip('Skipped', 'warn') : chip('Handed on', 'accent'),
    verb: skipped ? 'Not checked: Jev’s cap is spent' : 'Checked by Jev and handed on',
    failed: false,
    actor: 'jev',
    actorLabel,
    actorTitle: actorLabel,
    reason: checkReason(check),
    anomaly: ANOMALY_CHIPS[check.anomalyKind],
    anomalyKind: check.anomalyKind,
    count: 1,
    times: [{ compact: compactAgo(check.at, now), full: fullTime(check.at) }],
    outcome: undefined,
    check: check.verdict,
    ...(skipped ? {} : { cost: jevCost(check.costUsd) }),
  };
};

// ── The list ────────────────────────────────────────────────────────────────────────────────────

type Entry =
  | { readonly kind: 'action'; readonly at: number; readonly action: WardenAction }
  | {
      readonly kind: 'check';
      readonly at: number;
      readonly check: WardenJevCheck & { readonly verdict: 'handed_on' | 'skipped' };
    };

const atOf = (at: string): number => {
  const time = Date.parse(at);
  return Number.isFinite(time) ? time : 0;
};

const sameCheck = (left: WardenJevCheck, right: WardenJevCheck): boolean =>
  left.sessionId === right.sessionId &&
  left.anomalyKind === right.anomalyKind &&
  left.verdict === right.verdict &&
  left.why === right.why &&
  left.route === right.route;

const sameEntry = (left: Entry, right: Entry): boolean =>
  left.kind === 'action'
    ? right.kind === 'action' && sameRepeat(left.action, right.action)
    : right.kind === 'check' && sameCheck(left.check, right.check);

/**
 * Newest first — the Warden's actions and Jev's checks that settled nothing, on one timeline — with each
 * run of identical consecutive entries folded into one `×N` row.
 */
export const actionRows = (status: WardenStatusView, now: number): readonly WardenActionRow[] => {
  const entries: Entry[] = [
    ...status.actions.map(action => ({ kind: 'action' as const, at: atOf(action.at), action })),
    ...(status.jevChecks ?? []).filter(handedOn).map(check => ({ kind: 'check' as const, at: atOf(check.at), check })),
  ].sort((left, right) => right.at - left.at);
  const groups: { readonly head: Entry; readonly members: Entry[] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last !== undefined && sameEntry(last.head, entry)) last.members.push(entry);
    else groups.push({ head: entry, members: [entry] });
  }
  return groups.map(({ head, members }) => {
    const row = head.kind === 'action' ? rowFor(head.action, now) : checkRowFor(head.check, now);
    return members.length === 1
      ? row
      : {
          ...row,
          count: members.length,
          times: members.map(member => {
            const at = member.kind === 'action' ? member.action.at : member.check.at;
            return { compact: compactAgo(at, now), full: fullTime(at) };
          }),
        };
  });
};

/** Filters narrow the list; a `Closed` or `Failed` row has no outcome and shows only under All. */
export const filterActionRows = (
  rows: readonly WardenActionRow[],
  filters: ActionFilters,
): readonly WardenActionRow[] =>
  rows.filter(
    row =>
      (filters.actor === 'all' || row.actor === filters.actor) &&
      (filters.outcome === 'all' ||
        (filters.outcome === 'handed' ? row.check !== undefined : row.outcome === filters.outcome)),
  );

export interface ActionPage {
  readonly rows: readonly WardenActionRow[];
  /** How many more rows "Show more" would reveal. */
  readonly hidden: number;
}

export const pageActionRows = (rows: readonly WardenActionRow[], pages: number): ActionPage => {
  const shown = Math.max(1, pages) * ACTIONS_PAGE;
  return { rows: rows.slice(0, shown), hidden: Math.max(0, rows.length - shown) };
};

/** How many actions the list stands for, repeats counted — for the "N actions" tally. */
export const actionTotal = (rows: readonly WardenActionRow[]): number => rows.reduce((sum, row) => sum + row.count, 0);
