/**
 * The Recent actions list as rows: one line each, grouped, filtered and paged. Pure — the tsx only draws.
 *
 * Two rules the rows keep:
 *   1. WHO ACTED is read through `wardenActionActor`, so an older daemon's actions still carry an actor.
 *   2. A REPEAT IS CONSECUTIVE. Three identical actions in a row are one `×3` row; the same action
 *      returning after something else happened is a new row, because the gap is itself news.
 */

import type {
  WardenAction,
  WardenActionKind,
  WardenActor,
  WardenAnomalyKind,
  WardenOutcome,
  WardenStatusView,
} from '@ferretry/protocol';
import { displaySystemCallsign, wardenActionActor, wardenActionOutcome } from '@ferretry/protocol';
import { compactAgo, fullTime, optional, percent } from './warden-overview-model.ts';
import { ANOMALY_CHIPS, ACTOR_LABEL, chip, outcomeChip, type WardenChip } from './warden-vocabulary.ts';

export const ACTIONS_PAGE = 20;

export type ActorFilter = 'all' | 'auto' | 'jev' | 'llm';
export type OutcomeFilter = 'all' | WardenOutcome;

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
];

const VERB: Readonly<Record<WardenActionKind, string>> = {
  bless: 'Left alone',
  nudge: 'Nudged',
  resume: 'Resumed',
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
  readonly reportPath?: string;
  /** How many identical actions this row stands for. */
  readonly count: number;
  /** Newest first. The first is the row's own time. */
  readonly times: readonly ActionTime[];
  readonly outcome: WardenOutcome | undefined;
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
    ...optional('reportPath', action.reportPath),
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

const instant = (action: WardenAction): number => {
  const time = Date.parse(action.at);
  return Number.isFinite(time) ? time : 0;
};

/** Newest first, with each run of identical consecutive actions folded into one `×N` row. */
export const actionRows = (status: WardenStatusView, now: number): readonly WardenActionRow[] => {
  const sorted = [...status.actions].sort((left, right) => instant(right) - instant(left));
  const groups: { readonly head: WardenAction; readonly members: WardenAction[] }[] = [];
  for (const action of sorted) {
    const last = groups[groups.length - 1];
    if (last !== undefined && sameRepeat(last.head, action)) last.members.push(action);
    else groups.push({ head: action, members: [action] });
  }
  return groups.map(({ head, members }) => {
    const row = rowFor(head, now);
    return members.length === 1
      ? row
      : {
          ...row,
          count: members.length,
          times: members.map(member => ({ compact: compactAgo(member.at, now), full: fullTime(member.at) })),
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
      (filters.outcome === 'all' || row.outcome === filters.outcome),
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
