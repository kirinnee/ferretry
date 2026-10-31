/**
 * The Warden's actions counted one by one — action × outcome × who decided — and added up.
 *
 * `daily.ts` keeps what became of a FLAG (moved, cleared, stopped, asked); this keeps what the Warden
 * DID, so "how many revives, and by whom" has an answer even though a revive and a nudge are both
 * `moved`. A failed attempt and a held act are counted here too: they are the difference between
 * "revived 9" and "tried 14".
 *
 * Pure: no IO, no clock, no globals.
 */

import type {
  WardenActionOutcome,
  WardenActionTally,
  WardenActor,
  WardenActorCounts,
  WardenDayStats,
  WardenReviveResults,
  WardenStatActionKind,
} from '@ferretry/protocol';

const NO_COUNTS: WardenActorCounts = { auto: 0, jev: 0, llm: 0 };

export const NO_REVIVE_RESULTS: WardenReviveResults = { progressed: NO_COUNTS, stalled: NO_COUNTS };

const bumpedBy = (counts: WardenActorCounts, actor: WardenActor, by: number): WardenActorCounts => ({
  ...counts,
  [actor]: (counts[actor] ?? 0) + by,
});

/** Two counts added: `owner` appears only when either side has it. */
export const addActorCounts = (left: WardenActorCounts, right: WardenActorCounts): WardenActorCounts => ({
  auto: left.auto + right.auto,
  jev: left.jev + right.jev,
  llm: left.llm + right.llm,
  ...(left.owner === undefined && right.owner === undefined ? {} : { owner: (left.owner ?? 0) + (right.owner ?? 0) }),
});

const sameKind = (tally: WardenActionTally, action: WardenStatActionKind, outcome: WardenActionOutcome): boolean =>
  tally.action === action && tally.outcome === outcome;

/** The tallies with one more `action` that ended as `outcome`, decided by `actor`. */
export function tallyAction(
  acts: readonly WardenActionTally[] | undefined,
  action: WardenStatActionKind,
  outcome: WardenActionOutcome,
  actor: WardenActor,
): WardenActionTally[] {
  const current = acts ?? [];
  const found = current.find(tally => sameKind(tally, action, outcome));
  if (found === undefined) return [...current, { action, outcome, ...bumpedBy(NO_COUNTS, actor, 1) }];
  return current.map(tally => (tally === found ? { ...tally, ...bumpedBy(tally, actor, 1) } : tally));
}

/** Every day's tallies added up into one list, one entry per (action, outcome). */
export function sumActionTallies(days: readonly Pick<WardenDayStats, 'acts'>[]): WardenActionTally[] {
  let total: WardenActionTally[] = [];
  for (const day of days) {
    for (const tally of day.acts ?? []) {
      const found = total.find(entry => sameKind(entry, tally.action, tally.outcome));
      total =
        found === undefined
          ? [...total, tally]
          : total.map(entry => (entry === found ? { ...entry, ...addActorCounts(entry, tally) } : entry));
    }
  }
  return total;
}

/** Every day's revive results added up. */
export function sumReviveResults(days: readonly Pick<WardenDayStats, 'reviveResults'>[]): WardenReviveResults {
  return days.reduce<WardenReviveResults>(
    (total, day) =>
      day.reviveResults === undefined
        ? total
        : {
            progressed: addActorCounts(total.progressed, day.reviveResults.progressed),
            stalled: addActorCounts(total.stalled, day.reviveResults.stalled),
          },
    NO_REVIVE_RESULTS,
  );
}

/** A day with one revive settled: it `progressed` or `stalled`, decided by `actor`. */
export function settleRevive(
  results: WardenReviveResults | undefined,
  settled: 'progressed' | 'stalled',
  actor: WardenActor,
): WardenReviveResults {
  const current = results ?? NO_REVIVE_RESULTS;
  return { ...current, [settled]: bumpedBy(current[settled], actor, 1) };
}
