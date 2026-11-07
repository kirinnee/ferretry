import { type CardId, type CardRef, type CardResponse, type Lane, laneStage } from '../../../contract/index.ts';
import type { TranscriptEvent } from './transcript-events.ts';
import { BoardError } from './errors.ts';
import { BOARD_CHECK_TAIL, lastTurn } from './turn-check.ts';

/**
 * THE BACKSTOP UNDER "ONE ASK PER THING" (docs/board.md § Cards show progress; docs/agenda.md § Card asks).
 *
 * A card at a gate stage asks the owner through ONE agenda: the daemon puts its card ask on the agenda that carries
 * the card. A ferret that also raises its own item on the card ("please test this") makes the owner answer twice.
 * When a turn ends, the daemon reads it: if the turn raised an agenda item that is now open on a card sitting in a
 * gate lane, and ANOTHER open item on this agenda carries that card's open ask, the ferret gets ONE queued message
 * naming both: add yours to the one that carries the card, and drop your own.
 *
 * - **Only where the board is on**, and never for a sub-ferret (it raises nothing).
 * - **Evidence, not inference.** The turn's own tool calls say it raised something; the ferret's own open
 *   items on a gate card, raised since the turn began, say what.
 * - **Once per item.** The send id carries the item, so a turn end observed twice is one send.
 * - **A turn the check started is never checked**, so a reply to it cannot start a loop.
 * - **Silence when unsure.** No carrying agenda to point to, a card or session that cannot be read, a turn whose
 *   start time is unknown: nothing is said.
 *
 * Pure except {@link BoardGateCheck}, which reads and sends through its ports.
 */

const GATE_CHECK_OPENING = /^&\S+ already asks the owner on !/u;

/**
 * Whether a tool call raised an ask: the CLI under whatever binary name (`ask add|edit|answer`, `notify`), a Ferretry
 * `*_ask_owner` tool, or the harness's own question tool, which the daemon raises as an ask itself.
 */
const RAISING_COMMAND = /\b(?:ask["',\s]+(?:add|edit|answer)|notify)\b/u;
const RAISING_TOOL = /(?:^|_)ask_owner$|^AskUserQuestion$/u;

export const raisesAsk = (event: TranscriptEvent): boolean => {
  if (event.kind !== 'tool-call') return false;
  if (RAISING_TOOL.test(event.call.name)) return true;
  if (event.call.name.endsWith('_open') && JSON.stringify(event.call.input).includes('"askOwner"')) return true;
  return RAISING_COMMAND.test(JSON.stringify(event.call.input));
};

/** The part of an open ask the check reads. */
export interface GateCheckItem {
  readonly id: string;
  readonly raisedBy: 'human' | 'agent' | 'daemon';
  /** The card a ferret's own ask is about, when it names one. */
  readonly card?: CardRef | null | undefined;
  readonly waitingSince: string;
  readonly notice?: boolean | undefined;
  /** The cards for which this ask is the open ask of their gate (the `card` source's obligations). */
  readonly gateOf?: readonly CardId[] | undefined;
}

/** What the check reads and how it sends. */
export interface BoardGateCheckPorts {
  /** Whether the session has a transcript to read and is a lead (a sub-ferret raises no agenda items). */
  readonly readable: (ferret: string) => Promise<boolean>;
  /** Whether the session's board is on; a board that is off is never checked. */
  readonly boardOn: (ferret: string) => Promise<boolean>;
  /** The newest transcript events, oldest first. */
  readonly tail: (ferret: string, limit: number) => Promise<readonly TranscriptEvent[]>;
  /** The ferret's open asks, the daemon's gate asks included. */
  readonly open: (ferret: string) => Promise<readonly GateCheckItem[]>;
  /** One card with its board's lanes; a card that is gone is refused `not-found`. */
  readonly card: (ref: CardRef) => Promise<CardResponse>;
  /** The ordinary send; the same id twice is one message. */
  readonly send: (ferret: string, sendId: string, message: string) => Promise<void>;
  /** Journals that a nudge went out, with the ferret's items and the cards it named. */
  readonly record: (ferret: string, items: readonly string[], cards: readonly string[]) => Promise<void>;
}

/** Whether a lane is a gate stage: its stored stage, else the one its category and owner gate derive. */
export const isGateLane = (lane: Lane): boolean => laneStage(lane).kind === 'gate';

const atGate = (response: CardResponse): boolean => {
  if (response.card.dropped !== null) return false;
  const lane = response.laneSet?.lanes.find(candidate => candidate.id === response.card.laneId);
  return lane !== undefined && isGateLane(lane);
};

/** One ferret item to drop, with the card it sits on and the agenda that carries that card's ask. */
export interface DuplicateGateItem {
  readonly card: string;
  /** The agenda that carries the card's ask. */
  readonly gateItem: string;
  readonly item: string;
}

/** The words of the nudge, one line per duplicate. Short on purpose: it starts a turn. */
export const gateCheckMessage = (duplicates: readonly DuplicateGateItem[], binary: string): string =>
  duplicates
    .map(
      ({ card, gateItem, item }) =>
        `&${card} already asks the owner on !${gateItem}, which carries the card: put yours on it (${binary} ask edit ${gateItem} --where "<each existing point>" --where "<what you need>"; --where replaces them all, so repeat the ones already there), then drop !${item}: ${binary} ask dismiss !${item}`,
    )
    .join('\n');

/** The send id of the one nudge an item may get. */
export const gateCheckSendId = (ferret: string, items: readonly string[]): string =>
  `board-gate-check-${ferret}-${[...items].sort().join('-')}`;

/** Runs the check at a turn end. Every failure is swallowed by the caller: a check that cannot read says nothing. */
export class BoardGateCheck {
  private readonly told = new Set<string>();

  constructor(
    private readonly ports: BoardGateCheckPorts,
    private readonly binary: string,
  ) {}

  /** Checks the session's last turn; whether a nudge was sent. */
  async check(ferret: string): Promise<boolean> {
    if (!(await this.ports.readable(ferret))) return false;
    const { opener, turn, startedAt } = lastTurn(await this.ports.tail(ferret, BOARD_CHECK_TAIL));
    if (GATE_CHECK_OPENING.test(opener.trimStart())) return false;
    if (!turn.some(raisesAsk)) return false;
    const since = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
    if (Number.isNaN(since)) return false;
    if (!(await this.ports.boardOn(ferret))) return false;
    const open = await this.ports.open(ferret);
    const raised = open.filter(
      item =>
        item.raisedBy === 'agent' &&
        item.notice !== true &&
        item.card != null &&
        !this.told.has(item.id) &&
        Date.parse(item.waitingSince) >= since,
    );
    const duplicates: DuplicateGateItem[] = [];
    for (const item of raised) {
      const ref = item.card as CardRef;
      const gateItem = open.find(
        candidate => candidate.id !== item.id && (candidate.gateOf ?? []).includes(ref.id),
      );
      if (gateItem === undefined) continue;
      if (!(await this.atGate(ref))) continue;
      duplicates.push({ card: ref.id, gateItem: gateItem.id, item: item.id });
    }
    if (duplicates.length === 0) return false;
    const ids = duplicates.map(duplicate => duplicate.item);
    await this.ports.send(ferret, gateCheckSendId(ferret, ids), gateCheckMessage(duplicates, this.binary));
    for (const id of ids) this.told.add(id);
    await this.ports.record(ferret, ids, [...new Set(duplicates.map(duplicate => duplicate.card))]);
    return true;
  }

  private async atGate(ref: CardRef): Promise<boolean> {
    try {
      return atGate(await this.ports.card(ref));
    } catch (error) {
      if (error instanceof BoardError && error.code === 'not-found') return false;
      throw error;
    }
  }
}
