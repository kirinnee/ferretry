/**
 * START A FERRET ON A CARD, as the owner asks for it from a notice or a card (`docs/board.md`, "Start a ferret on
 * a card").
 *
 * The button starts a NEW ferret, never the card's old one: the owner asked for somebody on the card, and the old
 * ferret may be gone, may have been started for another repository, or may carry a focus the card has since left.
 * Everything the new ferret needs is decided here, from the card, and none of it comes from the client:
 *
 * - **the card** is its focus task and its anchor, and is assigned to it (`SessionCards.open`, the same write
 *   `fy new --card` makes) — the start itself moves the card into its working lane;
 * - **the folder** is the card's own project's folder, resolved from the card as it is NOW, so a card refiled to
 *   another project starts in that project's folder;
 * - **the runtime** is the machine's default (a start that names none);
 * - **the brief** is the card: its ask, summary, premise and context, how to test it, its links and last events.
 *
 * Idempotent and alone per card: the check and the start run as one {@link StartOnCardPorts.exclusive} step, so a
 * retry after a lost response, or a second client, finds the first start's ferret and gets it back instead of
 * starting another. A card a live ferret already holds is never started a second time.
 *
 * Pure: the card, the lock, the roster and the start arrive through the ports; authority is the caller's.
 */
import {
  type BoardTaskId,
  type BoardTaskView,
  type BoardTaskResponse,
  type BoardTaskStartResponse,
  categoryOf,
  formatTaskRef,
  type LaneSet,
} from '@ferretry/protocol';
import { focusCardBrief } from '../warden/focus-card.ts';
import type { BoardCaller } from './authority.ts';
import { BoardError } from './errors.ts';

/** What a new ferret on a card is started with: all of it the daemon's decision, none of it the client's. */
export interface NewFerretOnCard {
  readonly card: BoardTaskView;
  /** The card's project's folder. */
  readonly folder: string;
  /** What the session is called. */
  readonly name: string;
  /** The brief built from the card. */
  readonly prompt: string;
}

export interface StartOnCardPorts {
  task(id: BoardTaskId): Promise<BoardTaskResponse>;
  /** The folder the card's project is registered at; `undefined` for a project with none (Unfiled). */
  folderOf(card: BoardTaskView): Promise<string | undefined>;
  /** Every ferret that is alive on this machine, with the card it is working on (`null`: none). */
  live(): Promise<ReadonlyMap<string, BoardTaskId | null>>;
  /** Runs `work` alone for this card: a second start of the same card waits for the first to finish. */
  exclusive<T>(id: BoardTaskId, work: () => Promise<T>): Promise<T>;
  /** Starts the new ferret, with the card assigned to it; returns its session id. Throws {@link CardStartRefused}. */
  start(start: NewFerretOnCard): Promise<string>;
  /** Stops a ferret whose card was taken from it by a close that raced the start. */
  stop(sessionId: string, reason: string): Promise<void>;
  /** The shipped command name, so every command the brief prints exists after a rename. */
  readonly bin: string;
}

/** Why the new ferret would not start: the words are the start's own, for the person to read. */
export class CardStartRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardStartRefused';
  }
}

/** What the owner's start came to; `started: false` means a live ferret already holds the card and nothing was started. */
export type CardStarted = BoardTaskStartResponse;

const GONE = 'This card was closed; reopen it first.';

/** Whether the card was closed or dropped: nothing is started on it. */
function closed(card: BoardTaskView, laneSet: LaneSet | null): boolean {
  if (card.dropped !== null) return true;
  if (laneSet === null) return false;
  const category = categoryOf(laneSet, card.laneId);
  return category.ok && category.value === 'closed';
}

const section = (heading: string, text: string): readonly string[] =>
  text.trim() === '' ? [] : ['', `${heading}:`, text.trim()];

/**
 * The live ferret that holds the card: its assignee; else its owner, unless the card is unclaimed in the backlog
 * (nobody's work yet, so a lead being alive does not hold every card it has not handed out); else any live ferret
 * whose focus it is.
 */
function heldBy(
  card: BoardTaskView,
  laneSet: LaneSet | null,
  live: ReadonlyMap<string, BoardTaskId | null>,
): string | undefined {
  if (card.assignee !== null) {
    if (live.has(card.assignee)) return card.assignee;
  } else if (live.has(card.owner)) {
    const category = laneSet === null ? undefined : categoryOf(laneSet, card.laneId);
    if (category?.ok !== true || category.value !== 'backlog') return card.owner;
  }
  return [...live].find(([, focus]) => focus === card.id)?.[0];
}

/** The first turn of the new ferret: who asked, the card's own words, then the card as a continuing ferret reads it. */
export function startOnCardBrief(card: BoardTaskView, laneSet: LaneSet | null, bin: string): string {
  const ref = formatTaskRef(card);
  return [
    `The owner asked you to take over card ${ref}. Its last ferret has finished, so nobody else is working on it. Read what is already done, then carry on from there.`,
    ...section('Summary', card.summary),
    ...section('Why it exists', card.premise),
    ...section('Context', card.context),
    ...section('How to test', card.howToTest),
    '',
    focusCardBrief({ task: card, laneSet }),
    '',
    `The daemon assigned ${ref} to you and moved it into its working lane; \`${bin} task note\` adds progress.`,
  ].join('\n');
}

export async function startOnCard(ports: StartOnCardPorts, id: BoardTaskId, caller: BoardCaller): Promise<CardStarted> {
  if (caller.kind !== 'owner') {
    throw new BoardError('forbidden', 'only the owner may start a ferret on a card from here', ['owner-human']);
  }
  return await ports.exclusive(id, async () => {
    const { task, laneSet } = await ports.task(id);
    const ref = formatTaskRef(task);
    if (closed(task, laneSet)) throw new BoardError('invalid', GONE);
    const holder = heldBy(task, laneSet, await ports.live());
    if (holder !== undefined) return { task: task.id, sessionId: holder, started: false };
    const folder = await ports.folderOf(task);
    if (folder === undefined) {
      throw new BoardError(
        'invalid',
        `${ref} is not filed under a project folder on this machine, so there is nowhere to start a ferret on it. File it under a project first.`,
      );
    }
    let sessionId: string;
    try {
      sessionId = await ports.start({
        card: task,
        folder,
        name: task.title,
        prompt: startOnCardBrief(task, laneSet, ports.bin),
      });
    } catch (error) {
      if (error instanceof CardStartRefused)
        throw new BoardError('invalid', `No ferret was started on ${ref}: ${error.message}`);
      throw error;
    }
    // A close that raced the start wins: the assignment refuses a dropped card, the new ferret is left with no card.
    const after = (await ports.task(id)).task;
    if (after.assignee !== sessionId) {
      await ports.stop(sessionId, `${ref} was closed while the ferret started on it`);
      throw new BoardError('invalid', GONE);
    }
    return { task: task.id, sessionId, started: true };
  });
}
