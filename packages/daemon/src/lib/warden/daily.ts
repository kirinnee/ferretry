/**
 * The Warden's work, rolled up per UTC day by who acted — what the status shows as `history`.
 *
 * THREE KINDS OF COUNTER, ONE DOCUMENT. What became of a flag (`moved`, `cleared`, `stopped`, `asked`,
 * each split by actor) is counted AS IT HAPPENS, at the one place an action is recorded
 * ({@link recordWardenOutcome}): the action list is capped, so a busy day could never be rebuilt from
 * it. The rest — flags raised, Jev's decisions and spend, investigations and their cost — already live
 * in the state as today's triage counters and the investigation records, so they are FOLDED in
 * ({@link foldWardenDaily}) rather than counted twice. A fold only ever raises a number: a record
 * pruned from the capped list must not take a day's count down with it. Jev's checks — every flag it was
 * asked about, whatever it made of it, and every flag it was not asked about because its cap was spent —
 * are counted as they happen too ({@link recordWardenJevCheck}): a check that handed the flag on is in no
 * outcome, and was invisible before.
 *
 * Pure: no IO, no clock, no globals.
 */

import {
  type WardenActor,
  type WardenActorCounts,
  type WardenAction,
  type WardenDayStats,
  type WardenJevCheck,
  WARDEN_HISTORY_DAYS,
  wardenActionActor,
  wardenActionOutcome,
  type WardenOutcome,
} from '@ferretry/protocol';
import type { WardenEscalationReasonKind } from './escalation.ts';
import { countJevCheck, jevCheckDay } from './jev-checks.ts';
import type { WardenRuntimeState } from './state.ts';
import { instantMs } from './time.ts';
import { triageDayFor, utcDay, type WardenTriageDay } from './triage.ts';

/** How many UTC days the state keeps, today included. The status shows the last {@link WARDEN_HISTORY_DAYS}. */
export const WARDEN_DAILY_KEEP_DAYS = 14;

const NO_COUNTS: WardenActorCounts = { auto: 0, jev: 0, llm: 0 };

/** A day with nothing counted yet: a quiet day is a real zero, not a gap. */
export const emptyWardenDay = (day: string): WardenDayStats => ({
  day,
  flags: 0,
  jevDecisions: 0,
  investigations: 0,
  jevUsd: 0,
  investigationUsd: 0,
  moved: NO_COUNTS,
  cleared: NO_COUNTS,
  stopped: NO_COUNTS,
  asked: NO_COUNTS,
});

function bumped(counts: WardenActorCounts, actor: WardenActor): WardenActorCounts {
  return { ...counts, [actor]: (counts[actor] ?? 0) + 1 };
}

/** Replace (or add) one day, keeping the days oldest first and at most {@link WARDEN_DAILY_KEEP_DAYS}. */
function withDay(days: readonly WardenDayStats[], next: WardenDayStats): readonly WardenDayStats[] {
  const others = days.filter(entry => entry.day !== next.day);
  return [...others, next].toSorted((a, b) => a.day.localeCompare(b.day)).slice(-WARDEN_DAILY_KEEP_DAYS);
}

function dayOf(days: readonly WardenDayStats[] | undefined, day: string): WardenDayStats {
  return days?.find(entry => entry.day === day) ?? emptyWardenDay(day);
}

function count(day: WardenDayStats, outcome: WardenOutcome, actor: WardenActor): WardenDayStats {
  return { ...day, [outcome]: bumped(day[outcome], actor) };
}

/**
 * Count one recorded action on the day it happened, under who acted and what became of the flag.
 * A failed attempt and a closed leftover browser count as none of the outcomes
 * ({@link wardenActionOutcome}) and leave the state as it was.
 */
export function recordWardenOutcome(state: WardenRuntimeState, action: WardenAction): WardenRuntimeState {
  const outcome = wardenActionOutcome(action);
  const at = instantMs(action.at);
  if (outcome === undefined || at === undefined) return state;
  const day = utcDay(at);
  return {
    ...state,
    daily: withDay(state.daily ?? [], count(dayOf(state.daily, day), outcome, wardenActionActor(action))),
  };
}

/**
 * Count one flag handed to the owner that no held action records — an escalation, a `NEEDS_HUMAN`
 * verdict. `actor` is who decided it should go to them.
 */
/**
 * Who decided a notification should go to the owner, by why it was raised — or `undefined` for a held
 * action, which was already counted as asked when the hold was recorded and must not count twice.
 * An investigation's verdict is the LLM's; Jev's hand-on is Jev's; a failed investigation or a flag no
 * layer could look at goes to the owner by rule.
 */
export function wardenAskActor(reason: WardenEscalationReasonKind): WardenActor | undefined {
  switch (reason) {
    case 'needs_human':
      return 'llm';
    case 'jev':
      return 'jev';
    case 'investigation_failed':
    case 'untriaged':
      return 'auto';
    case 'held':
      return undefined;
  }
}

export function recordWardenAsk(state: WardenRuntimeState, at: string, actor: WardenActor): WardenRuntimeState {
  const ms = instantMs(at);
  if (ms === undefined) return state;
  const day = utcDay(ms);
  return { ...state, daily: withDay(state.daily ?? [], count(dayOf(state.daily, day), 'asked', actor)) };
}

/** Count one of Jev's checks into the day it was made (`jev-checks.ts`). */
export function recordWardenJevCheck(state: WardenRuntimeState, check: WardenJevCheck): WardenRuntimeState {
  const day = jevCheckDay(check);
  if (day === undefined) return state;
  return { ...state, daily: withDay(state.daily ?? [], countJevCheck(dayOf(state.daily, day), check)) };
}

const higher = (stored: number, seen: number): number => Math.max(stored, seen);

function withTriage(day: WardenDayStats, triage: WardenTriageDay): WardenDayStats {
  return {
    ...day,
    flags: higher(day.flags, triage.flags),
    jevDecisions: higher(day.jevDecisions, triage.jevDecisions),
    jevUsd: higher(day.jevUsd, triage.jevUsd),
  };
}

/**
 * The state with its daily rollup brought up to date at `nowMs`:
 *
 * - today's entry exists, so a quiet day is a zero;
 * - the triage counters (flags, Jev's decisions and spend) are folded into the day they belong to;
 * - every investigation record is counted on the day it STARTED, and its cost lands there too even
 *   if analytics priced it after midnight;
 * - nothing ever goes down, and only the last {@link WARDEN_DAILY_KEEP_DAYS} days are kept.
 */
export function foldWardenDaily(state: WardenRuntimeState, nowMs: number): WardenRuntimeState {
  let days: readonly WardenDayStats[] = state.daily ?? [];
  const today = utcDay(nowMs);
  days = withDay(days, dayOf(days, today));

  const triage = triageDayFor(state.triageDay, nowMs);
  days = withDay(days, withTriage(dayOf(days, today), triage));
  // A day that rolled over since the last write still holds yesterday's counters: fold them where they belong.
  if (state.triageDay !== undefined && state.triageDay.day !== today)
    days = withDay(days, withTriage(dayOf(days, state.triageDay.day), state.triageDay));

  const started = new Map<string, { count: number; usd: number }>();
  for (const record of state.investigations ?? []) {
    const at = instantMs(record.startedAt);
    if (at === undefined) continue;
    const day = utcDay(at);
    const seen = started.get(day) ?? { count: 0, usd: 0 };
    started.set(day, { count: seen.count + 1, usd: seen.usd + (record.costUsd ?? 0) });
  }
  for (const [day, seen] of started) {
    const stored = dayOf(days, day);
    days = withDay(days, {
      ...stored,
      investigations: higher(stored.investigations, seen.count),
      investigationUsd: higher(stored.investigationUsd, seen.usd),
    });
  }
  return { ...state, daily: days };
}

/** What the status shows: the last {@link WARDEN_HISTORY_DAYS} days the daemon kept, oldest first, today last. */
export function wardenHistory(state: WardenRuntimeState, nowMs: number): readonly WardenDayStats[] {
  return (foldWardenDaily(state, nowMs).daily ?? []).slice(-WARDEN_HISTORY_DAYS);
}

/**
 * A state store whose every write carries the daily rollup, so no call site has to remember to fold:
 * the state a sweep writes is always the state with today's entry present and the snapshot counters in.
 */
export function withDailyRollup(
  store: {
    read(): Promise<unknown>;
    write(state: WardenRuntimeState): Promise<void>;
  },
  nowMs: () => number,
): { read(): Promise<unknown>; write(state: WardenRuntimeState): Promise<void> } {
  return {
    read: async () => await store.read(),
    write: async state => await store.write(foldWardenDaily(state, nowMs())),
  };
}
