/**
 * THE BOARD IS OPT-IN, ENFORCED (docs/board.md § The board is opt-in): whether a FERRET may make a task. The owner
 * decided (2026-11-01) that most work needs no task, and the Board rule said so in words alone — a ferret whose
 * other instructions told it to record every task made one anyway. So the daemon decides, on `fy task new` and on a
 * `fy task refile` onto another board (a task made where the board is on must not be moved onto one that is off).
 *
 * A ferret's task lands on a board that is off only when ONE of these holds, and is refused otherwise:
 *
 * 1. **The board is on**: the owner switched the project's board on (`fy board on`).
 * 2. **A live parent it holds**: the task goes under a task on that same board, neither dropped nor closed, that the
 *    ferret may adopt under (its own, or one its lead handed it) — it is splitting work already on the board.
 * 3. **The owner's Yes**: `--approval !A<n>` names an ask the ferret raised on its OWN ledger, the yes/no question
 *    "Track … on the board?", that the owner answered Yes. One Yes makes one task; a refile carries the Yes its task
 *    was made on.
 *
 * The owner's words alone are no proof: a keyword test over them passed "track down the bug" and "the card field"
 * (security review of #1341), and the Yes costs the owner one tap.
 *
 * Only a ferret on its own credential is asked. The owner, the daemon (the task `fy new` makes for a helper, a
 * gate, a PR) and the admin token are not; a helper is refused every task before this is reached.
 *
 * Pure and total: the service gathers the facts and throws the refusal.
 */
import { type Task, TRACK_ASK_COMMAND } from '../../../contract/index.ts';
import type { AnsweredAsk } from './ports.ts';
import { ASK_REFERENCE_SIGIL } from '@ferretry/core-asks/contract';

/** The question the owner's Yes must answer: "Track this on the board?", in the ferret's words for "this". */
export const TRACK_QUESTION = /^\s*track\b[^?]*\bon the board\b\s*\??\s*$/iu;

/** What a ferret's task on a board rests on; `null` is a refusal. */
export type TaskLicence = 'board-on' | 'parent' | 'approval';

/** Everything the decision reads, gathered by the service. */
export interface TaskLicenceFacts {
  /** Whether the task's board is switched on. */
  readonly boardOn: boolean;
  /** Whether the task goes under a live parent on that board the caller may adopt under (the service checked). */
  readonly parent: boolean;
  /** Whether the task rests on the owner's Yes, already judged by {@link approvalProblem}. */
  readonly approved: boolean;
}

/** The first proof that holds, in the order the rule reads; `null` when none does. */
export const taskLicence = (facts: TaskLicenceFacts): TaskLicence | null => {
  if (facts.boardOn) return 'board-on';
  if (facts.parent) return 'parent';
  if (facts.approved) return 'approval';
  return null;
};

const YES = 'yes';
const NO = 'no';

/** The labels of an ask's options, folded: a yes/no asks exactly Yes and No. */
const isYesNo = (ask: Pick<AnsweredAsk, 'options'>): boolean => {
  const choices = ask.options.map(option => option.trim().toLowerCase());
  return choices.length === 2 && choices.includes(YES) && choices.includes(NO);
};

/**
 * Why the item `--approval` names is not the owner's Yes to tracking, or `null` when it is. `item` is the answered
 * item of that id on the CALLER's own agenda (`undefined` when there is none); `usedBy` is the task already made on
 * it, if any.
 */
export const approvalProblem = (
  id: string,
  ask: AnsweredAsk | undefined,
  caller: string,
  usedBy: Pick<Task, 'id'> | undefined,
): string | null => {
  const ref = `${ASK_REFERENCE_SIGIL}${id}`;
  if (ask === undefined) return `${ref} is not an answered ask on your ledger`;
  if (ask.raisedBy !== 'ferret' || ask.raisedByFerret !== caller) return `${ref} is not an ask you raised`;
  if (!isYesNo(ask)) return `${ref} is not a yes/no question`;
  if (![ask.subject, ask.title ?? ''].some(text => TRACK_QUESTION.test(text))) {
    return `${ref} does not ask "Track this on the board?"`;
  }
  if (ask.answer?.by !== 'owner') return `${ref} was not answered by the owner`;
  if (ask.answer.choice?.trim().toLowerCase() !== YES) return `the owner did not answer Yes to ${ref}`;
  if (usedBy !== undefined) return `${ref} already made &${usedBy.id}; one Yes makes one task`;
  return null;
};

/**
 * The refusal a ferret reads: the board is off, so put what the owner must decide on the agenda; to track the work
 * anyway, ask first. `problem` is why a named approval did not count.
 */
export const offBoardRefusal = (board: string, problem?: string): string =>
  [
    `The ${board} board is off, so this work needs no task: put only what the owner must decide or do on your agenda (fy agenda add …).`,
    problem === undefined ? undefined : `The approval does not count: ${problem}.`,
    `To track it anyway, ask first: ${TRACK_ASK_COMMAND} — then, once the owner says Yes, fy task new … --approval <ask>.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join(' ');
