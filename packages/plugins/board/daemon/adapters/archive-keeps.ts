import {
  type ArchiveTaskStanding,
  ArchiveCardStandingsSchema,
  type ArchiveKeepSource,
  type FerretId,
  FerretIdSchema,
} from '@ferretry/core-ferrets/contract';
import type { Task } from '../../contract/index.ts';
import { taskCategory, type LaneSets } from '../lib/board/index.ts';

/** What Board reads of itself to answer the archive: every task as stored, with every board's lanes (`snapshot`). */
export interface BoardTaskSnapshot {
  snapshot(): Promise<{ readonly cards: readonly Task[]; readonly laneSets: LaneSets }>;
}

/**
 * A stored party as Ferrets names a ferret, or `undefined` when it is not a ferret id. Board stores a party as plain
 * text (`FerretRefSchema`); Ferrets' answer takes only ferret ids. A string that is not a ferret id can never match a
 * ferret the archive decides about, so leaving it out keeps nobody less live than before.
 */
const ferretOf = (party: string | null): FerretId | undefined => {
  if (party === null) return undefined;
  const parsed = FerretIdSchema.safeParse(party);
  return parsed.success ? parsed.data : undefined;
};

/**
 * One task as the archive's keep rule reads it: today's `sessionsOnOpenTasks` read `owner`, `assignee`, `dropped` and
 * `taskCategory(task, laneSets)` of every stored task. A lane Board cannot name stays `undefined`, which the rule
 * reads as "in flight" (when unsure, keep).
 *
 * Each party is parsed as a ferret id, and one that is not is LEFT OUT, so one odd stored task never makes the whole
 * answer unreadable (Ferrets parses the whole list, and one bad owner would stop every pass). The contract needs an
 * owner on every standing: a task whose owner is not a ferret id but whose assignee is answers with the assignee as its
 * owner (the rule keeps owner and assignee alike, so nothing is lost); a task with neither names no ferret and is left
 * out (`undefined`).
 */
const taskStanding = (task: Task, laneSets: LaneSets): ArchiveTaskStanding | undefined => {
  const owner = ferretOf(task.owner);
  const assignee = ferretOf(task.assignee);
  const named = owner ?? assignee;
  if (named === undefined) return undefined;
  return {
    owner: named,
    assignee: owner === undefined ? null : (assignee ?? null),
    dropped: task.dropped !== null,
    category: taskCategory(task, laneSets),
  };
};

/**
 * Board's half of `session.archive-keeps`: every task, closed and dropped included, so Ferrets' rule decides which
 * ferrets a task still in flight holds. Read afresh on every ask, never cached. A read that fails REJECTS: Ferrets reads
 * a rejection as "the board is unreadable" and keeps every ferret it was asked about (fail safe, never "archive").
 * The answer is checked against Ferrets' own `ArchiveCardStandingsSchema` before it leaves Board, so a standing Ferrets
 * would refuse is a rejection here (the same keep-live outcome), and the two halves cannot drift apart unseen.
 */
export const boardArchiveKeeps = (board: BoardTaskSnapshot): ArchiveKeepSource => ({
  kind: 'board',
  cards: async () => {
    const { cards: tasks, laneSets } = await board.snapshot();
    const standings = tasks.flatMap(task => {
      const standing = taskStanding(task, laneSets);
      return standing === undefined ? [] : [standing];
    });
    ArchiveCardStandingsSchema.parse(standings);
    return standings;
  },
});
