/**
 * START A FERRET ON A CARD, as the owner asks for it from a notice or a card (`docs/board.md`, "Start a ferret on
 * a card").
 *
 * The owner's button resumes the card's own ferret, with the card as its brief: the same turn the Warden hands a
 * ferret it starts again (`focusCardBrief`). It does not start a fresh one, because a fresh start is a lead's act —
 * it needs a parent ferret to delegate the card from — and an owner standing at a notice has none. The cost is
 * stated, not hidden: when the card's ferret is no longer on this machine there is nothing to resume, and the
 * answer says so and points at `fy task assign`.
 *
 * Pure: the card, the resume and the lead lookup arrive through the ports; authority is the caller's.
 */
import { type BoardTaskId, type BoardTaskResponse, formatTaskRef } from '@ferretry/protocol';
import { focusCardBrief } from '../warden/focus-card.ts';
import { type BoardCaller, effectiveAssignee } from './authority.ts';
import { BoardError } from './errors.ts';

/** Why the card's ferret would not start again: the words are the resume domain's, for the person to read. */
export class CardStartRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardStartRefused';
  }
}

export interface StartOnCardPorts {
  task(id: BoardTaskId): Promise<BoardTaskResponse>;
  /** Whether the ferret is a session this machine still holds. */
  exists(sessionId: string): Promise<boolean>;
  /** Whether the ferret was started by another ferret, so its brief must not tell it to move cards. */
  isSubFerret(sessionId: string): Promise<boolean>;
  /** Brings the ferret back with this as its next turn; throws {@link CardStartRefused} when it will not come. */
  resume(sessionId: string, message: string): Promise<void>;
}

/** What the owner's start did: the card, and the ferret that is on it again. */
export interface CardStarted {
  readonly task: BoardTaskId;
  readonly sessionId: string;
}

/** The first turn of the ferret the owner started again. */
function startOnCardMessage(brief: string): string {
  return `The owner asked for you to carry on with your card. Re-read your last turn and continue from where you stopped, on the card below.\n\n${brief}`;
}

export async function startOnCard(ports: StartOnCardPorts, id: BoardTaskId, caller: BoardCaller): Promise<CardStarted> {
  if (caller.kind !== 'owner') {
    throw new BoardError('forbidden', 'only the owner may start a ferret on a card from here', ['owner-human']);
  }
  const { task, laneSet } = await ports.task(id);
  const ref = formatTaskRef(task);
  const ferret = effectiveAssignee(task);
  if (!(await ports.exists(ferret))) {
    throw new BoardError(
      'not-found',
      `${ref}'s ferret is no longer on this machine, so it cannot be started again. Hand the card to another ferret instead (\`fy task assign ${task.id} <ferret>\`), or close it.`,
    );
  }
  const subFerret = await ports.isSubFerret(ferret);
  const message = startOnCardMessage(focusCardBrief({ task, laneSet, ...(subFerret ? { subFerret } : {}) }));
  try {
    await ports.resume(ferret, message);
  } catch (error) {
    if (error instanceof CardStartRefused)
      throw new BoardError('invalid', `${ref}'s ferret did not start: ${error.message}`);
    throw error;
  }
  return { task: task.id, sessionId: ferret };
}
