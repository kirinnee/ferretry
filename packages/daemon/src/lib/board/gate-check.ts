import { type BoardTaskResponse, type Lane, type TaskRef, laneStage } from '@ferretry/protocol';
import { raisesAgendaItem } from '../agenda/turn-nudge.ts';
import type { TranscriptEvent } from '../transcript/types.ts';
import { BoardError } from './errors.ts';
import { BOARD_CHECK_TAIL, lastTurn } from './turn-check.ts';

/**
 * THE BACKSTOP UNDER "NEVER RAISE AN AGENDA ITEM FOR A GATE" (docs/board.md, "Gates").
 *
 * A card that reaches a gate stage raises ONE agenda item for the owner itself — the daemon does, so there is
 * never a task notice and an agenda notice for the same thing. A ferret that also raises its own item on the
 * card ("please test this") makes the owner answer twice. When a turn ends, the daemon reads it: if the turn
 * raised an agenda item that is now open on a card sitting in a gate lane, and the daemon's own gate item for
 * that card is open too, the ferret gets ONE queued message naming both and the command that drops its own.
 *
 * - **Only where the board is on**, and never for a sub-ferret (it raises nothing).
 * - **Evidence, not inference.** The turn's own tool calls say it raised something; the ferret's own open
 *   items on a gate card, raised since the turn began, say what.
 * - **Once per item.** The send id carries the item, so a turn end observed twice is one send.
 * - **A turn the check started is never checked**, so a reply to it cannot start a loop.
 * - **Silence when unsure.** No gate item to point to, a card or session that cannot be read, a turn whose
 *   start time is unknown: nothing is said.
 *
 * Pure except {@link BoardGateCheck}, which reads and sends through its ports.
 */

const GATE_CHECK_OPENING = /^&\S+ is at a gate; the daemon already asked the owner/u;

/** The prefix of the `sourceRef` of every gate item the daemon raises: `gate:<card>:<lane>:<entry>`. */
const GATE_SOURCE_PREFIX = 'gate:';

/** The part of an open agenda item the check reads. */
export interface GateCheckItem {
  readonly id: string;
  readonly raisedBy: 'human' | 'agent' | 'daemon';
  readonly sourceRef: string | null;
  readonly task?: TaskRef | null | undefined;
  readonly waitingSince: string;
  readonly notice?: boolean | undefined;
}

/** What the check reads and how it sends. */
export interface BoardGateCheckPorts {
  /** Whether the session has a transcript to read and is a lead (a sub-ferret raises no agenda items). */
  readonly readable: (sessionId: string) => Promise<boolean>;
  /** Whether the session's board is on; a board that is off is never checked. */
  readonly boardOn: (sessionId: string) => Promise<boolean>;
  /** The newest transcript events, oldest first. */
  readonly tail: (sessionId: string, limit: number) => Promise<readonly TranscriptEvent[]>;
  /** The session's open agenda items, the daemon's gate items included. */
  readonly open: (sessionId: string) => Promise<readonly GateCheckItem[]>;
  /** One card with its board's lanes; a card that is gone is refused `not-found`. */
  readonly card: (ref: TaskRef) => Promise<BoardTaskResponse>;
  /** The ordinary send; the same id twice is one message. */
  readonly send: (sessionId: string, sendId: string, message: string) => Promise<void>;
  /** Journals that a nudge went out, with the ferret's items and the cards it named. */
  readonly record: (sessionId: string, items: readonly string[], cards: readonly string[]) => Promise<void>;
}

/** Whether a lane is a gate stage: its stored stage, else the one its category and owner gate derive. */
export const isGateLane = (lane: Lane): boolean => laneStage(lane).kind === 'gate';

const atGate = (response: BoardTaskResponse): boolean => {
  if (response.task.dropped !== null) return false;
  const lane = response.laneSet?.lanes.find(candidate => candidate.id === response.task.laneId);
  return lane !== undefined && isGateLane(lane);
};

/** One ferret item to drop, with the card it sits on and the daemon's gate item for that card. */
export interface DuplicateGateItem {
  readonly card: string;
  readonly gateItem: string;
  readonly item: string;
}

/** The words of the nudge, one line per duplicate. Short on purpose: it starts a turn. */
export const gateCheckMessage = (duplicates: readonly DuplicateGateItem[], binary: string): string =>
  duplicates
    .map(
      ({ card, gateItem, item }) =>
        `&${card} is at a gate; the daemon already asked the owner (!${gateItem}). Drop yours: ${binary} agenda dismiss !${item}`,
    )
    .join('\n');

/** The send id of the one nudge an item may get. */
export const gateCheckSendId = (sessionId: string, items: readonly string[]): string =>
  `board-gate-check-${sessionId}-${[...items].sort().join('-')}`;

/** Runs the check at a turn end. Every failure is swallowed by the caller: a check that cannot read says nothing. */
export class BoardGateCheck {
  private readonly told = new Set<string>();

  constructor(
    private readonly ports: BoardGateCheckPorts,
    private readonly binary: string,
  ) {}

  /** Checks the session's last turn; whether a nudge was sent. */
  async check(sessionId: string): Promise<boolean> {
    if (!(await this.ports.readable(sessionId))) return false;
    const { opener, turn, startedAt } = lastTurn(await this.ports.tail(sessionId, BOARD_CHECK_TAIL));
    if (GATE_CHECK_OPENING.test(opener.trimStart())) return false;
    if (!turn.some(raisesAgendaItem)) return false;
    const since = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
    if (Number.isNaN(since)) return false;
    if (!(await this.ports.boardOn(sessionId))) return false;
    const open = await this.ports.open(sessionId);
    const raised = open.filter(
      item =>
        item.raisedBy === 'agent' &&
        item.notice !== true &&
        item.task != null &&
        !this.told.has(item.id) &&
        Date.parse(item.waitingSince) >= since,
    );
    const duplicates: DuplicateGateItem[] = [];
    for (const item of raised) {
      const ref = item.task as TaskRef;
      const gateItem = open.find(
        candidate =>
          candidate.raisedBy === 'daemon' &&
          candidate.sourceRef?.startsWith(`${GATE_SOURCE_PREFIX}${ref.id}:`) === true,
      );
      if (gateItem === undefined) continue;
      if (!(await this.atGate(ref))) continue;
      duplicates.push({ card: ref.id, gateItem: gateItem.id, item: item.id });
    }
    if (duplicates.length === 0) return false;
    const ids = duplicates.map(duplicate => duplicate.item);
    await this.ports.send(sessionId, gateCheckSendId(sessionId, ids), gateCheckMessage(duplicates, this.binary));
    for (const id of ids) this.told.add(id);
    await this.ports.record(sessionId, ids, [...new Set(duplicates.map(duplicate => duplicate.card))]);
    return true;
  }

  private async atGate(ref: TaskRef): Promise<boolean> {
    try {
      return atGate(await this.ports.card(ref));
    } catch (error) {
      if (error instanceof BoardError && error.code === 'not-found') return false;
      throw error;
    }
  }
}
