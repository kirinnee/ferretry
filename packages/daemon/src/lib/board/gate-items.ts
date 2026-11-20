/**
 * CARDS SHOW PROGRESS; THEIR ASKS RIDE THE AGENDA (docs/board.md § Cards show progress; docs/agenda.md § Card asks).
 * A card never asks the owner itself. When an owner-asked card reaches a lane whose stage is a gate (OK to build, or
 * Done / Not good), the daemon puts ONE card ask on the agenda that carries the card, keeps it in line with the card
 * whatever moved it, and applies the owner's answer to the card.
 *
 * - **Attaching.** After every committed write of a card ({@link GateItems.written}, by any path: a move, a trigger,
 *   PR facts, a refile, `fy signal done`) and once at boot ({@link GateItems.backfill}), a card at a gate has its ask
 *   on exactly one open agenda, in this order: an open agenda that carries the card already (it is about the card, or
 *   it carries one of the card's asks); else one that carries its parent card; else a NEW agenda named after the
 *   card on its ferret's home, raised on that ferret's behalf. A new ask wakes its agenda into Needs you, even out of
 *   a snooze: it is a blocker of the card. A standalone gate item is never raised again.
 * - **One per machine.** A card changes hands and its agenda stays where it is, so the agendas that carry a card are
 *   looked for on EVERY agenda that ever held one, not only its ferrets' of today. An ask the owner answered (or set
 *   aside, closing its agenda) is never asked again.
 * - **Leaving.** A card no longer at that gate (moved on by the owner on the Board, dropped, refiled) has its open ask
 *   withdrawn quietly; the agenda stays, for its ferret to close.
 * - **Answering** ({@link GateItems.answer}): only a human. The card moves FIRST, as the owner, through the board;
 *   only a move that went through records the answer, so an ask is never answered while its card stayed put. The
 *   agenda then RESTS, waiting on its ferret, which is told; the answer never closes it.
 *
 * An internal card (its lead's bookkeeping) never asks: its owner ferret or a lead passes its gate itself. Nor does a
 * sub-card at a lane the owner tries things in: the owner tests the parent.
 */
import { createHash } from 'node:crypto';
import {
  type AgendaCardAsk,
  type AgendaGate,
  type AgendaGateOption,
  type AgendaId,
  type AgendaItem,
  type AgendaResponse,
  type AgendaSnapshot,
  type BoardReopenAttachments,
  type BoardTask,
  type BoardTaskActionRequest,
  type BoardTaskId,
  canCarryCardAsk,
  cardAskOf,
  cardAskReference,
  carriesCard,
  clipAtWord,
  formatTaskRef,
  gateChoice,
  gateReference,
  gateReopenOption,
  gatesAnsweredOn,
  isOpenCardAsk,
  MAX_BOARD_REASON_LENGTH,
  mirroredCardAsk,
  openCardAsks,
  parseCardAgendaReference,
  parseGateFollowupReference,
  parseGateReference,
  type ResolvedAgendaItem,
} from '@ferretry/protocol';
import { type CardAskOperation, LEGACY_REPLAY_MS } from '../agenda/card-asks.ts';
import type { AgendaQueryResult } from '../agenda/service.ts';
import type { AgendaActor, AgendaMutation, RaiseAgendaRequest } from '../agenda/state-machine.ts';
import { type BoardCaller, effectiveAssignee } from './authority.ts';
import {
  cardAgendaRaise,
  type GateCard,
  type GateLanes,
  gateMoveReason,
  gateOf,
  howToTestOf,
  nothingToTryReason,
  tryItVerdict,
} from './gate-policy.ts';
import type { CardWriteObserver } from './service.ts';

/** The agenda operations the card asks use. */
interface GateAgenda {
  list(sessionId: string): Promise<AgendaQueryResult<AgendaSnapshot>>;
  raise(sessionId: string, request: RaiseAgendaRequest, actor: AgendaActor): Promise<AgendaMutation>;
  resolve(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation>;
  cardAsk(sessionId: string, id: AgendaId, operation: CardAskOperation): Promise<AgendaMutation>;
  answer(sessionId: string, id: AgendaId, response: AgendaResponse, actor: AgendaActor): Promise<AgendaMutation>;
}

/** The board as the card asks read and write it: one card or every card, and the owner's act on one. */
export interface GateBoard {
  card(id: BoardTaskId): Promise<GateCard | undefined>;
  cards(): Promise<readonly GateCard[]>;
  /**
   * Applies one action as `caller`; throws the board's refusal. `expect` is checked in the same write: the card must
   * still sit in that lane by that entry, or nothing is written.
   */
  act(id: BoardTaskId, request: BoardTaskActionRequest, caller: BoardCaller, expect?: GateExpectation): Promise<void>;
  /**
   * The daemon's own move of a card out of a try-it lane into the closed lane, reason beside it: the one pass of a gate
   * that is not the owner's. Written only while the card still sits at `expect`; `false` when it did not close.
   */
  closeNothingToTry(id: BoardTaskId, expect: GateExpectation, reason: string): Promise<boolean>;
}

/** Tells a card's ferret the owner's answer, through the reopen ladder. */
interface GateWords {
  told(task: BoardTask, message: string, key: string): Promise<void>;
}

/** Where the files an answer carries are moved to the card's ferret, answering their ids as they are THERE; rejects when one cannot be carried. */
interface GateFiles {
  carry(from: string, to: string, ids: readonly string[]): Promise<readonly string[]>;
}

/** Every session on this machine whose agenda may carry a card: a card changes hands, its agendas do not. */
interface GateSessions {
  all(): Promise<readonly string[]>;
}

/** Where the one-time sweep of duplicate gate items records that it ran: once, for this daemon's home. */
export interface GateItemsMigrationMarker {
  ran(): Promise<boolean>;
  /** Records that it ran, and every item it closed (`<session> !A<n>`). */
  record(at: string, closed: readonly string[]): Promise<void>;
}

/**
 * Where the daemon asks the owner for a session: its agenda home (docs/agenda.md § Sub-ferret agenda), the owner's own
 * ferret at the root of its lineage — never a sub-ferret.
 */
interface GateHomes {
  of(sessionId: string): Promise<string>;
}

export interface GateItemsDependencies {
  readonly agenda: GateAgenda;
  readonly board: GateBoard;
  readonly lanes: GateLanes;
  readonly words: GateWords;
  /** Absent where this daemon cannot carry files: an answer that brings some is refused. */
  readonly files?: GateFiles;
  readonly sessions: GateSessions;
  readonly homes: GateHomes;
  readonly marker: GateItemsMigrationMarker;
  readonly now: () => string;
  readonly diagnostics: { warn(message: string): void };
}

/** What answering a card ask came to. */
export type GateAnswerOutcome =
  /** Not an answer to a card ask: answer the agenda's own ask as any other. */
  | { readonly handled: false }
  | { readonly handled: true; readonly mutation: AgendaMutation }
  | { readonly handled: true; readonly refused: GateRefusal };

export interface GateRefusal {
  readonly code: 'forbidden' | 'invalid' | 'moved-on' | 'not-moved';
  readonly message: string;
}

/** One answer to a card ask, as the agenda route received it. */
export interface GateAnswer {
  readonly sessionId: string;
  readonly id: AgendaId;
  readonly response: AgendaResponse;
  readonly note?: string | null | undefined;
  /** Files the owner brings with a Not good, uploaded to THIS agenda's session (`from` is `sessionId`). */
  readonly attachments?: BoardReopenAttachments | undefined;
  readonly actor: AgendaActor;
  /** Who the board records the move as: the owner's app, or the admin token at the machine. */
  readonly caller: BoardCaller;
  /**
   * Whether this human may move the card at all — a paired device needs the board's own grant — asked only once the
   * answer is known to be to a card ask, before the board is touched: the refusal's words, or `undefined` when it may.
   */
  readonly permitted?: () => string | undefined;
  /** The response picks one of a card ask's options (an app that predates card asks: the one `gateAttached` shows). */
  readonly gate?: true | undefined;
  /** Which card ask, by its reference (`agenda.card-asks.1`); absent, the one `gateAttached` mirrors. */
  readonly cardAsk?: string | undefined;
  /** The `askVersion` the app was shown, kept with the answer. */
  readonly askVersion?: number | undefined;
}

/** Where a card's ask is open now: the agenda that carries it. */
export interface GateAsking {
  readonly sessionId: string;
  readonly id: AgendaId;
}

/** Where an answer expects the card to be when its move is written: the gate's lane, by the entry it asked about. */
export interface GateExpectation {
  readonly laneId: string;
  readonly entry: number;
}

const DAEMON: AgendaActor = { kind: 'daemon', cause: 'system' };

interface OpenItem {
  readonly sessionId: string;
  readonly item: AgendaItem;
}

/** A card's agendas on the agendas that hold any, and the asks already answered. */
interface HeldItems {
  /** The open agendas that carry the card and can carry its ask. */
  readonly carriers: readonly OpenItem[];
  /** The open agendas that carry the parent card, when the card has one. */
  readonly parents: readonly OpenItem[];
  /** The open Not good conversations of earlier rounds (`gate-followup:`), from before card asks. */
  readonly followups: readonly OpenItem[];
  /**
   * The references of this card's asks the OWNER answered or set aside: answered on any agenda, open on the card's
   * own agenda (`card-agenda:`) the owner closed, or a gate item from before card asks the owner closed. Each of
   * those has been asked, for good.
   */
  readonly asked: ReadonlySet<string>;
}

/** The card a daemon item of the gate producers is about: a follow-up or a card agenda. */
const producedFor = (item: Pick<AgendaItem, 'raisedBy' | 'source' | 'sourceRef'>): string | undefined => {
  if (item.raisedBy !== 'daemon' || item.source !== 'task') return undefined;
  return (
    parseGateReference(item.sourceRef)?.cardId ??
    parseGateFollowupReference(item.sourceRef)?.cardId ??
    parseCardAgendaReference(item.sourceRef)
  );
};

/** Every card an item carries, for the scan that remembers where each card's agendas are. */
const cardsOf = (item: AgendaItem | ResolvedAgendaItem): string[] => [
  ...(item.task === undefined || item.task === null ? [] : [item.task.id]),
  ...(item.cardAsks ?? []).map(ask => ask.gate.cardId),
  ...(item.gate === undefined ? [] : [item.gate.cardId]),
  ...[producedFor(item)].flatMap(id => (id === undefined ? [] : [id])),
];

/** The newer of two items: the one that started needing the owner later, the later session on a tie. */
const newer = (one: OpenItem, other: OpenItem): OpenItem => {
  const order = Date.parse(other.item.waitingSince) - Date.parse(one.item.waitingSince);
  return order > 0 || (order === 0 && other.sessionId > one.sessionId) ? other : one;
};

/** The one agenda of `pool` to put the ask on: one on the card's ferret's home, on the owner's turn, then the newest. */
const pick = (pool: readonly OpenItem[], home: readonly string[]): OpenItem | undefined => {
  if (pool.length === 0) return undefined;
  for (const sessionId of home) {
    const there = pool.filter(each => each.sessionId === sessionId);
    if (there.length > 0) return choose(there);
  }
  return choose(pool);
};

const choose = (pool: readonly OpenItem[]): OpenItem | undefined => {
  const theirs = pool.filter(each => each.item.waitingOn === undefined && each.item.parked === undefined);
  const from = theirs.length > 0 ? theirs : pool;
  return from.length === 0 ? undefined : from.reduce(newer);
};

/** Whether a follow-up is still going with the owner: on their turn, or with anything said after `since`. */
const talking = (item: AgendaItem, since: number): boolean =>
  (item.waitingOn === undefined && item.parked === undefined) || lastActivity(item) > since;

/** When anything last happened on an item: raised, woken, asked, talked over, edited or parked. */
const lastActivity = (item: AgendaItem): number =>
  Math.max(
    ...[
      item.waitingSince,
      item.askedAt,
      item.parked?.at,
      ...(item.history ?? []).map(each => each.at),
      ...(item.revisions ?? []).map(each => each.at),
    ].flatMap(at => (at === undefined ? [] : [Date.parse(at)])),
  );

/** Runs `work` once every earlier one queued under `key` has settled: one at a time per key. */
const serially = async <T>(
  queues: Map<BoardTaskId, Promise<unknown>>,
  key: BoardTaskId,
  work: () => Promise<T>,
): Promise<T> => {
  const turn = (queues.get(key) ?? Promise.resolve()).then(work);
  const tail = turn.catch(() => undefined);
  queues.set(key, tail);
  try {
    return await turn;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The ask an answer is to: the one it names, else (an app that predates card asks) the one `gateAttached` mirrors —
 * and, when none is open, the one answered last within {@link LEGACY_REPLAY_MS}, so a retry of that very answer (a lost
 * response) finds it and is read as the repeat it is.
 */
const askOf = (item: AgendaItem | ResolvedAgendaItem, answer: GateAnswer, now: number): AgendaCardAsk | undefined => {
  if (answer.cardAsk !== undefined) return cardAskOf(item, answer.cardAsk);
  return mirroredCardAsk(item) ?? answeredLast(item, answer, now);
};

/**
 * The ask answered within {@link LEGACY_REPLAY_MS} of `now` that this answer repeats — the one whose own answer says
 * exactly what this does — else the one answered last, so a retry of an older answer is not read against a newer one.
 */
const answeredLast = (
  item: AgendaItem | ResolvedAgendaItem,
  answer: GateAnswer,
  now: number,
): AgendaCardAsk | undefined => {
  const recent = (item.cardAsks ?? []).filter(
    ask => ask.answer !== undefined && now - Date.parse(ask.answer.at) < LEGACY_REPLAY_MS,
  );
  const repeated = recent.find(ask => {
    const decision = decide(ask.gate, answer);
    return !('code' in decision) && receiptOf(answer, decision) === ask.answer?.receipt;
  });
  if (repeated !== undefined || recent.length === 0) return repeated;
  return recent.reduce((one, other) =>
    Date.parse(other.answer?.at ?? '') > Date.parse(one.answer?.at ?? '') ? other : one,
  );
};

/**
 * The answer, addressed to the item on this agenda that carries the ask it names now: one merged into another, or split
 * off with its card, took its asks along (docs/agenda.md § Merge and split), so a screen still showing the old item
 * answers the very same ask, under the same authority and receipt. Only for an ask named by its reference: an app that
 * predates card asks names none, and the one the other item shows may be another card's. Unchanged when no item
 * reached that way carries it.
 */
const followed = (answer: GateAnswer, items: readonly (AgendaItem | ResolvedAgendaItem)[]): GateAnswer => {
  const reference = answer.cardAsk;
  if (reference === undefined) return answer;
  const carries = (id: AgendaId): boolean => {
    const item = items.find(each => each.id === id);
    return item !== undefined && cardAskOf(item, reference) !== undefined;
  };
  if (carries(answer.id)) return answer;
  // Merges and splits can chain (a split child that split again), so every item reached is visited once: a loop ends
  // when nothing new is left, and the answer stays where it was.
  const seen = new Set<AgendaId>([answer.id]);
  const queue: AgendaId[] = [answer.id];
  for (const from of queue) {
    const item = items.find(each => each.id === from);
    // Both ways on: an item split earlier and merged since keeps the path to the child its card went to.
    for (const next of [...(item?.mergedInto === undefined ? [] : [item.mergedInto]), ...(item?.splitInto ?? [])]) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (carries(next)) return { ...answer, id: next };
      queue.push(next);
    }
  }
  return answer;
};

/** Whether the answer is to a card ask at all: it names one, or says it picks the shown one's option. */
const toCardAsk = (answer: GateAnswer): boolean => answer.cardAsk !== undefined || answer.gate === true;

export class GateItems implements CardWriteObserver {
  /** Cards whose ask is being answered right now: their own writes are the answer's, not a card moving on. */
  private readonly answering = new Set<BoardTaskId>();
  /** One answer per card at a time: the tail of each card's queue of answers. */
  private readonly answers = new Map<BoardTaskId, Promise<unknown>>();
  /** One pass over a card's asks at a time, so two writes of one card never put its ask on two agendas. */
  private readonly passes = new Map<BoardTaskId, Promise<unknown>>();
  /** Which agendas hold (or held) items about each card: read once from all, then kept as they are written. */
  private readonly holders = new Map<string, Set<string>>();
  /** The one read of every agenda behind {@link holders}, once it has started. */
  private scanning: Promise<void> | undefined;

  constructor(private readonly ports: GateItemsDependencies) {}

  private now(): number {
    return Date.parse(this.ports.now());
  }

  /** Whether this open item carries a card ask the owner has yet to answer: setting it aside needs the board's grant. */
  async isGate(sessionId: string, id: AgendaId): Promise<boolean> {
    const listed = await this.ports.agenda.list(sessionId);
    return listed.ok && listed.value.items.some(each => each.id === id && openCardAsks(each).length > 0);
  }

  /** A card was written: its ask follows its lane. Never rejects. */
  async written(id: BoardTaskId): Promise<void> {
    if (this.answering.has(id)) return;
    const card = await this.ports.board.card(id).catch(() => undefined);
    if (card === undefined) return;
    await this.reconcile(card).catch((error: unknown) =>
      this.ports.diagnostics.warn(`the ask of ${formatTaskRef({ id })} could not follow it: ${errorText(error)}`),
    );
  }

  /**
   * At boot: the old duplicates sweep runs if it never has, and every card's ask is brought in line with its lane —
   * one at a gate gets its ask, one whose card moved on while the daemon was down loses it. Each card on its own;
   * returns how many asks it put on an agenda.
   */
  async backfill(): Promise<number> {
    await this.sweepDuplicates().catch((error: unknown) =>
      this.ports.diagnostics.warn(`the sweep of duplicate gate items failed: ${errorText(error)}`),
    );
    return await this.reconcileAll(card => card);
  }

  /** Every card at a gate is looked at again; returns how many asks it put on an agenda. */
  async sweep(): Promise<number> {
    return await this.reconcileAll(card => (gateOf(card, this.ports.lanes) === undefined ? undefined : card));
  }

  private async reconcileAll(choose: (card: GateCard) => GateCard | undefined): Promise<number> {
    let attached = 0;
    for (const card of (await this.ports.board.cards()).map(choose)) {
      if (card === undefined) continue;
      try {
        if (await this.reconcile(card)) attached += 1;
      } catch (error) {
        this.ports.diagnostics.warn(`the ask of ${formatTaskRef(card.task)} could not be put: ${errorText(error)}`);
      }
    }
    return attached;
  }

  /**
   * The owner's answer to a card ask: the card moves first, as the owner, and only then is the answer recorded. A
   * refusal leaves the ask open and says why. `handled: false` for an answer that is not to a card ask. A plain answer
   * to an open gate item from before card asks — one the boot migration could not read onto an agenda — is refused:
   * the agenda would close it with its card unmoved.
   */
  async answer(answer: GateAnswer): Promise<GateAnswerOutcome> {
    if (!toCardAsk(answer)) return (await this.unmigrated(answer)) ?? { handled: false };
    const found = await this.find(answer);
    if (found === undefined) return refused('moved-on', `${answer.id} asks nothing about a card, so nothing was moved`);
    // Answers to one card take turns: the second reads the board the first one left.
    return await serially(this.answers, found.gate.cardId, async () => await this.answerAlone(found.answer));
  }

  /** A refusal when the answer is to an open gate item the migration left as it was; `undefined` for any other item. */
  private async unmigrated(answer: GateAnswer): Promise<GateAnswerOutcome | undefined> {
    const listed = await this.ports.agenda.list(answer.sessionId);
    const gate = listed.ok ? listed.value.items.find(each => each.id === answer.id)?.gate : undefined;
    return gate === undefined
      ? undefined
      : refused(
          'not-moved',
          `${answer.id} is an older question about ${formatTaskRef({ id: gate.cardId })} that this version could not bring up to date, so your answer moved nothing. Tap Not needed to set it aside`,
        );
  }

  /**
   * The item and the ask an answer is to, open or answered; a closed item from before card asks by its gate. The
   * answer comes back addressed to that item: one that names its ask may reach the item it was merged into or split
   * off with ({@link followed}).
   */
  private async find(answer: GateAnswer): Promise<
    | {
        readonly item: AgendaItem | ResolvedAgendaItem;
        readonly gate: AgendaGate;
        readonly answer: GateAnswer;
      }
    | undefined
  > {
    const listed = await this.ports.agenda.list(answer.sessionId);
    if (!listed.ok) return undefined;
    const to = followed(answer, [...listed.value.items, ...listed.value.resolved]);
    const item =
      listed.value.items.find(each => each.id === to.id) ?? listed.value.resolved.find(each => each.id === to.id);
    if (item === undefined) return undefined;
    const gate = askOf(item, to, this.now())?.gate ?? ('resolvedAt' in item ? item.gate : undefined);
    return gate === undefined ? undefined : { item, gate, answer: to };
  }

  private async answerAlone(answer: GateAnswer): Promise<GateAnswerOutcome> {
    const listed = await this.ports.agenda.list(answer.sessionId);
    if (!listed.ok) return refused('not-moved', `${answer.id}'s agenda could not be read, so nothing was moved`);
    const open = listed.value.items.find(each => each.id === answer.id);
    if (open === undefined) return await this.replayedClosed(answer, listed.value.resolved);
    const ask = askOf(open, answer, this.now());
    if (ask === undefined) {
      return refused('moved-on', `${answer.id} no longer asks that, so nothing was moved`);
    }
    const gate = ask.gate;
    if (answer.actor.kind !== 'human') {
      return refused(
        'forbidden',
        `only the owner answers ${answer.id}'s question: it decides where ${formatTaskRef({ id: gate.cardId })} goes next`,
      );
    }
    const denied = answer.permitted?.();
    if (denied !== undefined) return refused('forbidden', denied);
    const decision = decide(gate, answer);
    if ('code' in decision) return { handled: true, refused: decision };
    const unfit = this.filesRefusal(answer, decision);
    if (unfit !== undefined) return { handled: true, refused: unfit };
    const receipt = receiptOf(answer, decision);
    if (!isOpenCardAsk(ask)) return await this.replayedOpen(answer, open, ask, receipt);
    const stale = this.legacyRepeat(answer, open, ask, receipt);
    if (stale !== undefined) return { handled: true, refused: stale };
    const card = await this.ports.board.card(gate.cardId);
    const here = card === undefined ? undefined : gateOf(card, this.ports.lanes);
    const reference = cardAskReference(ask);
    if (card === undefined || here === undefined || gateReference(here) !== reference) {
      await this.ports.agenda
        .cardAsk(answer.sessionId, answer.id, { kind: 'withdraw', reference })
        .catch(() => undefined);
      return refused(
        'moved-on',
        `${formatTaskRef({ id: gate.cardId })} is no longer in ${gate.laneName}, so nothing was moved`,
      );
    }
    this.answering.add(card.task.id);
    try {
      const applied = await this.apply(card, gate, decision, answer);
      if (applied !== undefined) return { handled: true, refused: applied };
      const operation: CardAskOperation =
        decision.kind === 'not-yet'
          ? { kind: 'not-yet', reference, ...(decision.note === null ? {} : { note: decision.note }) }
          : {
              kind: 'answered',
              reference,
              answer: {
                at: this.ports.now(),
                response: answer.response,
                ...(decision.note === null ? {} : { note: decision.note }),
                receipt,
                // The version of the ask on the screen the owner answered from, kept as given even when the ask has
                // since moved to another item (a merge, a split): it is what they saw, and nothing checks it here.
                ...(answer.askVersion === undefined ? {} : { askVersion: answer.askVersion }),
              },
            };
      const { mutation, carrier } = await this.record(answer, operation);
      if (mutation.ok && decision.kind === 'option') await this.tellAnswered(card.task, gate, decision, carrier);
      return { handled: true, mutation };
    } finally {
      this.answering.delete(card.task.id);
      await this.written(card.task.id);
    }
  }

  /**
   * Records the operation on the item the answer reached. The card has moved by now, so an item merged or split since
   * (the ask went with it) is not a reason to lose the answer: after any refusal its carrier is looked for again, and
   * the operation goes there. A merge closes the item (not found); a split leaves it open without the ask (invalid): the
   * refusal's code is not what tells them apart, {@link followed} is. Returns the answer as addressed to where it was
   * recorded.
   */
  private async record(
    answer: GateAnswer,
    operation: CardAskOperation,
  ): Promise<{ readonly mutation: AgendaMutation; readonly carrier: GateAnswer }> {
    const mutation = await this.ports.agenda.cardAsk(answer.sessionId, answer.id, operation);
    if (mutation.ok) return { mutation, carrier: answer };
    const listed = await this.ports.agenda.list(answer.sessionId).catch(() => undefined);
    if (listed === undefined || !listed.ok) return { mutation, carrier: answer };
    const carrier = followed(answer, [...listed.value.items, ...listed.value.resolved]);
    if (carrier.id === answer.id) return { mutation, carrier: answer };
    return { mutation: await this.ports.agenda.cardAsk(carrier.sessionId, carrier.id, operation), carrier };
  }

  /**
   * An answer that repeats one the owner already gave to this ask (a lost response replayed, a second tap): the agenda
   * comes back unchanged and nothing moves. The WHOLE of it must match — the same choice with other words or other
   * files is a stale tab, refused, never a success that drops them.
   */
  private async replayedOpen(
    answer: GateAnswer,
    item: AgendaItem,
    ask: AgendaCardAsk,
    receipt: string,
  ): Promise<GateAnswerOutcome> {
    if (ask.answer?.receipt !== receipt) {
      return refused('moved-on', `${answer.id}'s question was already answered, differently: nothing was sent`);
    }
    const mutation = await this.ports.agenda.cardAsk(answer.sessionId, item.id, {
      kind: 'answered',
      reference: cardAskReference(ask),
      answer: ask.answer,
    });
    return { handled: true, mutation };
  }

  /**
   * A repeat that reaches a CLOSED item: one whose card ask was answered before its ferret marked it done, or a gate
   * item from before card asks. Nothing moves; a whole match comes back as the closed item stands, anything else is
   * refused. An item answered before receipts were kept takes a repeat only when it brings no files.
   */
  private async replayedClosed(
    answer: GateAnswer,
    resolved: readonly ResolvedAgendaItem[],
  ): Promise<GateAnswerOutcome> {
    const closed = resolved.find(each => each.id === answer.id);
    const ask = closed === undefined ? undefined : askOf(closed, answer, this.now());
    const gate = ask?.gate ?? closed?.gate;
    if (closed === undefined || gate === undefined) {
      return refused('moved-on', `${answer.id} is closed, so nothing was moved`);
    }
    if (answer.actor.kind !== 'human') return refused('forbidden', `only the owner answers ${answer.id}`);
    const denied = answer.permitted?.();
    if (denied !== undefined) return refused('forbidden', denied);
    const decision = decide(gate, answer);
    if ('code' in decision) return { handled: true, refused: decision };
    const unfit = this.filesRefusal(answer, decision);
    if (unfit !== undefined) return { handled: true, refused: unfit };
    const receipt = receiptOf(answer, decision);
    const same =
      ask?.answer !== undefined
        ? ask.answer.receipt === receipt
        : closed.response !== undefined &&
          JSON.stringify(closed.response) === JSON.stringify(answer.response) &&
          (closed.answerReceipt === undefined
            ? answer.attachments === undefined && closed.resolutionNote === decision.note
            : closed.answerReceipt === receipt);
    if (!same) return refused('moved-on', `${answer.id} was already answered, differently: nothing was sent`);
    // An answer to a closed item changes nothing: it comes back as the item was closed.
    const mutation = await this.ports.agenda.answer(answer.sessionId, answer.id, answer.response, answer.actor);
    return { handled: true, mutation };
  }

  /**
   * An app that predates card asks names no ask: it answers the one `gateAttached` shows. When an ask on this agenda
   * was answered moments ago with these very words, this answer is that one retried or tapped twice — whenever the
   * shown ask came to the agenda, since the owner may well not have seen it — and is refused rather than spent on an
   * ask they never saw. So is an answer within the same two minutes of the shown ask taking another one's place
   * (`gateAttachedChangedAt`): the screen that sent it may still draw the first. (An app that names its ask,
   * `agenda.card-asks.1`, is never in doubt.)
   */
  private legacyRepeat(
    answer: GateAnswer,
    item: AgendaItem,
    shown: AgendaCardAsk,
    receipt: string,
  ): GateRefusal | undefined {
    if (answer.cardAsk !== undefined) return undefined;
    const now = this.now();
    const earlier = (item.cardAsks ?? []).find(
      each => each.answer?.receipt === receipt && now - Date.parse(each.answer.at) < LEGACY_REPLAY_MS,
    );
    if (earlier !== undefined) {
      return {
        code: 'moved-on',
        message: `${formatTaskRef({ id: earlier.gate.cardId })} was just answered on ${answer.id}; it now asks about ${formatTaskRef({ id: shown.gate.cardId })}: read it, and answer again in two minutes`,
      };
    }
    // The shown ask took another one's place a moment ago (answered or withdrawn elsewhere): a screen that still draws
    // the old one has not shown the owner this one.
    const replaced = item.gateAttachedChangedAt;
    if (replaced === undefined || now - Date.parse(replaced) >= LEGACY_REPLAY_MS) return undefined;
    return {
      code: 'moved-on',
      message: `${answer.id} just changed to ask about ${formatTaskRef({ id: shown.gate.cardId })}: read it, and answer again in two minutes`,
    };
  }

  /** The agendas a card's new agenda belongs on: the home of its assignee first, then the home of its owner ferret. */
  private async sessionsOf(task: Pick<BoardTask, 'assignee' | 'owner'>): Promise<readonly string[]> {
    const homes = await Promise.all(
      [effectiveAssignee(task), task.owner].map(async each => await this.ports.homes.of(each).catch(() => each)),
    );
    return [...new Set(homes)];
  }

  /** Brings one card's ask in line with its lane, one pass per card at a time; `true` when it put a new ask. */
  private async reconcile(card: GateCard): Promise<boolean> {
    return await serially(this.passes, card.task.id, async () => await this.reconcileAlone(card));
  }

  private async reconcileAlone(card: GateCard): Promise<boolean> {
    const { task } = card;
    const seen = gateOf(card, this.ports.lanes);
    const home = await this.sessionsOf(task);
    const held = await this.held(task, home);
    // At a try-it lane the daemon first asks whether there is anything to try (`tryItVerdict`).
    // A gate the owner already answered (a Not yet) is never closed under them: that ask was made, for good.
    const verdict =
      seen === undefined || held.asked.has(gateReference(seen))
        ? undefined
        : tryItVerdict({ ...task, blockedBy: card.blockedBy, building: card.building }, seen);
    // Nothing to try: the card closes, so what follows is the card as it stands NOW, past that gate.
    const closed =
      seen !== undefined &&
      verdict?.kind === 'nothing' &&
      (await this.closeNothing(card, seen, verdict.why, held, home));
    if (verdict?.kind === 'nothing' && !closed) return false;
    const gate = closed ? undefined : seen;
    // Blocked: the card is not ready to try, so nothing is asked, and an ask still waiting for the owner is taken back
    // (the card stays where it is; the next look after it is unblocked asks again). Only a try-it gate can wait, and it
    // offers no Not yet: an ask the owner answered is never judged here (`held.asked`).
    const wanted = gate === undefined || verdict?.kind === 'wait' ? undefined : gateReference(gate);
    // Every open ask of this card but the one its lane asks now goes, wherever it is; a second copy of that one too.
    const asking = held.carriers.filter(each => openCardAsks(each.item).some(ask => ask.gate.cardId === task.id));
    const keeper =
      wanted === undefined
        ? undefined
        : pick(
            asking.filter(each => holds(each.item, wanted)),
            home,
          );
    for (const each of asking) {
      for (const ask of openCardAsks(each.item).filter(ask => ask.gate.cardId === task.id)) {
        const reference = cardAskReference(ask);
        if (reference === wanted && each === keeper) continue;
        await this.operate(each, { kind: 'withdraw', reference });
      }
    }
    if (gate === undefined || wanted === undefined) return false;
    await this.closeEarlierRounds(task, gate, held.followups);
    const operation: CardAskOperation = {
      kind: 'attach',
      ask: { gate, ...withSteps(howToTestOf(task, gate)) },
    };
    // Already asked: restated as the card stands now (a renamed lane, new steps), never asked a second time.
    if (keeper !== undefined) {
      await this.operate(keeper, operation);
      return false;
    }
    if (held.asked.has(wanted)) return false;
    for (const carrier of [pick(held.carriers, home), pick(held.parents, home)]) {
      if (carrier === undefined) continue;
      if (await this.operate(carrier, operation)) return true;
    }
    // Before a new agenda of its own: the topic the card was made from, when that is still open.
    const topic = await this.topicOf(task, home);
    if (topic !== undefined && (await this.operate(topic, operation))) return true;
    return await this.open(task, gate, home);
  }

  /**
   * The daemon closes a card with nothing to try, with one plain line for the owner and no question. The line goes on
   * the open agenda that already carries the card, when there is one; with none, no agenda is raised: the card's own
   * history says why. `true` once the card is closed; `false` when it moved on first (the next look reads it as it is).
   * The card's own write is not a reason to look again, so it is not read as a card moving on while it is written.
   */
  private async closeNothing(
    card: GateCard,
    gate: AgendaGate,
    why: string,
    held: HeldItems,
    home: readonly string[],
  ): Promise<boolean> {
    const reason = nothingToTryReason(why);
    this.answering.add(card.task.id);
    try {
      if (
        !(await this.ports.board.closeNothingToTry(card.task.id, { laneId: gate.laneId, entry: gate.entry }, reason))
      ) {
        return false;
      }
    } finally {
      this.answering.delete(card.task.id);
    }
    const carrier = pick(held.carriers, home);
    if (carrier !== undefined)
      await this.operate(carrier, { kind: 'line', line: `${formatTaskRef(card.task)}: ${reason}` });
    return true;
  }

  /**
   * The agenda the card was made from, when it is still open on one of the card's own sessions and can carry its ask:
   * `task.approval` (the Yes it was made on), else the first `!A<n>` its ask's source names. A card asks on its topic's
   * item, never on a new item of its own per gate.
   */
  private async topicOf(task: BoardTask, home: readonly string[]): Promise<OpenItem | undefined> {
    const named = task.approval ?? undefined;
    const id = named?.id ?? /!(A[1-9][0-9]*)/u.exec(task.ask.source)?.[1];
    if (id === undefined) return undefined;
    for (const sessionId of named === undefined ? home : home.filter(each => each === named.sessionId)) {
      const listed = await this.ports.agenda.list(sessionId).catch(() => undefined);
      const item = listed?.ok === true ? listed.value.items.find(each => each.id === id) : undefined;
      if (item !== undefined && canCarryCardAsk(item)) return { sessionId, item };
    }
    return undefined;
  }

  /** One card-ask operation on one agenda; `true` when it changed the agenda. A refusal is said and not thrown. */
  private async operate(on: OpenItem, operation: CardAskOperation): Promise<boolean> {
    const mutation = await this.ports.agenda.cardAsk(on.sessionId, on.item.id, operation);
    if (!mutation.ok) {
      this.ports.diagnostics.warn(
        `could not ${operation.kind} an ask about a card on !${on.item.id} of ${on.sessionId}: ${mutation.error.message}`,
      );
      return false;
    }
    if (mutation.changed) this.rememberAll(on.item, on.sessionId);
    return mutation.changed;
  }

  /** A new agenda for the card on the first of its sessions that takes it; `true` when one was opened. */
  private async open(task: BoardTask, gate: AgendaGate, sessions: readonly string[]): Promise<boolean> {
    const request = cardAgendaRaise(gate, task, this.ports.now());
    const refusals: string[] = [];
    for (const sessionId of sessions) {
      const mutation = await this.ports.agenda.raise(sessionId, request, DAEMON);
      if (mutation.ok) {
        this.remember(task.id, sessionId);
        return mutation.change === 'created';
      }
      refusals.push(`${sessionId}: ${mutation.error.message}`);
    }
    this.ports.diagnostics.warn(`no agenda for ${formatTaskRef(task)} in ${gate.laneName}: ${refusals.join('; ')}`);
    return false;
  }

  /**
   * Where this card's ask is open now, or `undefined` when it is not. A board or agenda that cannot be read THROWS:
   * "not asking" would let a second ask through.
   */
  async asking(cardId: BoardTaskId): Promise<GateAsking | undefined> {
    const card = await this.ports.board.card(cardId);
    const gate = card === undefined ? undefined : gateOf(card, this.ports.lanes);
    if (card === undefined || gate === undefined) return undefined;
    const held = await this.held(card.task, await this.sessionsOf(card.task), true);
    const wanted = gateReference(gate);
    const found = held.carriers.find(each => holds(each.item, wanted));
    return found === undefined ? undefined : { sessionId: found.sessionId, id: found.item.id };
  }

  /**
   * Back at a gate: the Not good conversations of EARLIER rounds (raised before card asks) have done their work,
   * wherever they are — but never one still going with the owner, or one that now carries a card ask.
   */
  private async closeEarlierRounds(task: BoardTask, gate: AgendaGate, followups: readonly OpenItem[]): Promise<void> {
    const back = task.history.find(each => each.seq === gate.entry)?.at;
    if (back === undefined) return;
    for (const followup of followups) {
      const round = parseGateFollowupReference(followup.item.sourceRef)?.entry ?? gate.entry;
      if (round >= gate.entry || talking(followup.item, Date.parse(back))) continue;
      if (openCardAsks(followup.item).length > 0) continue;
      await this.ports.agenda.resolve(
        followup.sessionId,
        followup.item.id,
        DAEMON,
        `the card is back in ${gate.laneName}`,
      );
    }
  }

  /**
   * The card's agendas, on its ferrets' agendas and on every other that ever held one of its items. An agenda that
   * cannot be read holds none, unless `strict`: then it throws.
   */
  private async held(task: BoardTask, home: readonly string[], strict = false): Promise<HeldItems> {
    const cardId = task.id;
    const parentId = task.parent?.id;
    await this.scanned();
    const carriers: OpenItem[] = [];
    const parents: OpenItem[] = [];
    const followups: OpenItem[] = [];
    const asked = new Set<string>();
    // The references of this card's asks that some scanned item (open or closed) carries: that item's own ask state is
    // the word on them, so a gate-answered line, which only speaks for an ask nothing carries, is left out for them.
    const carried = new Set<string>();
    const lines = new Set<string>();
    const sessions = new Set([
      ...home,
      ...(this.holders.get(cardId) ?? []),
      ...(parentId === undefined ? [] : (this.holders.get(parentId) ?? [])),
    ]);
    for (const sessionId of sessions) {
      const listed = strict
        ? await this.ports.agenda.list(sessionId)
        : await this.ports.agenda.list(sessionId).catch(() => undefined);
      if (listed === undefined || !listed.ok) {
        if (strict) throw new Error(`${sessionId}'s agenda could not be read`);
        continue;
      }
      for (const item of listed.value.items) {
        for (const ask of item.cardAsks ?? []) {
          if (ask.gate.cardId !== cardId) continue;
          carried.add(cardAskReference(ask));
          if (ask.answer !== undefined) asked.add(cardAskReference(ask));
        }
        if (!canCarryCardAsk(item)) continue;
        if (carriesCard(item, cardId, task.machineId)) carriers.push({ sessionId, item });
        else if (parentId !== undefined && carriesCard(item, parentId, task.machineId))
          parents.push({ sessionId, item });
        if (producedFor(item) === cardId && parseGateFollowupReference(item.sourceRef) !== undefined) {
          followups.push({ sessionId, item });
        }
      }
      for (const item of listed.value.resolved) {
        for (const ask of item.cardAsks ?? []) {
          if (ask.gate.cardId !== cardId) continue;
          carried.add(cardAskReference(ask));
          // Answered, or still open when the OWNER closed the card's OWN agenda: either way, asked. Their Not needed on
          // a ferret's thread that happened to carry the ask drops that thread, not the ask: it is put again.
          if (
            ask.answer !== undefined ||
            (item.resolvedBy === 'human' && parseCardAgendaReference(item.sourceRef) !== undefined)
          )
            asked.add(cardAskReference(ask));
        }
        for (const reference of gatesAnsweredOn(item)) {
          if (parseGateReference(reference)?.cardId === cardId) lines.add(reference);
        }
        if (item.resolvedBy === 'human' && item.gate !== undefined && item.gate.cardId === cardId) {
          asked.add(gateReference(item.gate));
        }
      }
    }
    // Not yet is written as an answer too, but leaves its ask open: the ask is put again when the thread that carried it
    // is set aside, even after the thread was merged into another (the line stays behind, the ask went along). A line
    // counts only for an ask no item carries any more: a legacy gate item, or an answered ask the agenda dropped.
    for (const reference of lines) if (!carried.has(reference)) asked.add(reference);
    return { carriers, parents, followups, asked };
  }

  /** Every agenda read once for the cards whose items it holds; a pass that could not list them is tried again. */
  private async scanned(): Promise<void> {
    this.scanning ??= this.scan().catch((error: unknown) => {
      this.scanning = undefined;
      this.ports.diagnostics.warn(`the agendas holding asks about cards could not be listed: ${errorText(error)}`);
    });
    await this.scanning;
  }

  private async scan(): Promise<void> {
    for (const sessionId of await this.ports.sessions.all()) {
      const listed = await this.ports.agenda.list(sessionId).catch(() => undefined);
      if (listed === undefined || !listed.ok) continue;
      for (const item of [...listed.value.items, ...listed.value.resolved]) this.rememberAll(item, sessionId);
    }
  }

  private rememberAll(item: AgendaItem | ResolvedAgendaItem, sessionId: string): void {
    for (const cardId of cardsOf(item)) this.remember(cardId, sessionId);
  }

  /** `sessionId`'s agenda holds an item about the card: where to look after it changes hands. */
  private remember(cardId: string, sessionId: string): void {
    const sessions = this.holders.get(cardId) ?? new Set<string>();
    sessions.add(sessionId);
    this.holders.set(cardId, sessions);
  }

  /**
   * THE ONE-TIME SWEEP (B138), from before card asks: every gate asked on more than one agenda kept its NEWEST item,
   * and the others were closed. Agendas are read into card asks now, so a start finds no gate item left to sweep; the
   * marker still records that it ran.
   */
  private async sweepDuplicates(): Promise<void> {
    if (await this.ports.marker.ran()) return;
    const byGate = new Map<string, OpenItem[]>();
    let complete = true;
    for (const sessionId of await this.ports.sessions.all()) {
      const listed = await this.ports.agenda.list(sessionId).catch(() => undefined);
      if (listed === undefined || !listed.ok) {
        complete = false;
        continue;
      }
      for (const item of listed.value.items) {
        if (item.gate === undefined || item.sourceRef === null || parseGateReference(item.sourceRef) === undefined)
          continue;
        byGate.set(item.sourceRef, [...(byGate.get(item.sourceRef) ?? []), { sessionId, item }]);
      }
    }
    const closed: string[] = [];
    for (const items of byGate.values()) {
      const kept = items.reduce(newer);
      for (const other of items.filter(each => each !== kept)) {
        const mutation = await this.ports.agenda
          .resolve(other.sessionId, other.item.id, DAEMON, `closed as a duplicate of !${kept.item.id}`)
          .catch(() => undefined);
        if (mutation?.ok === true) closed.push(`${other.sessionId} !${other.item.id}`);
        else complete = false;
      }
    }
    if (complete) await this.ports.marker.record(this.ports.now(), closed);
    else this.ports.diagnostics.warn('the sweep of duplicate gate items is unfinished; the next start tries again');
  }

  /** Moves the card as the answer says; a refusal when the board would not. */
  private async apply(
    card: GateCard,
    gate: AgendaGate,
    decision: Decision,
    answer: GateAnswer,
  ): Promise<GateRefusal | undefined> {
    const { task, laneSet } = card;
    if (decision.kind === 'not-yet') {
      if (decision.words !== undefined) await this.notYet(task, decision.words, answer);
      return undefined;
    }
    if (laneSet === null) return { code: 'not-moved', message: `${formatTaskRef(task)} has no lanes any more` };
    const target = this.ports.lanes.outcomeLane(laneSet, task.workflow, gate.laneId, decision.option.id);
    if (!target.ok) return { code: 'not-moved', message: `${formatTaskRef(task)} was not moved: ${target.message}` };
    const expect: GateExpectation = { laneId: gate.laneId, entry: gate.entry };
    if (decision.option.outcome !== 'reopen-with-agenda') {
      return await this.act(
        task.id,
        { action: 'move', to: target.lane.id, reason: gateMoveReason(decision.option) },
        answer,
        expect,
      );
    }
    const words = decision.words ?? '';
    const carried = await this.carried(task, answer);
    if (carried !== undefined && 'code' in carried) return carried;
    // The reopen tells the card's ferret the owner's words; the talk about the rework stays on THIS agenda.
    return await this.act(
      task.id,
      {
        action: 'reopen',
        to: target.lane.id,
        reason: clipAtWord(words, MAX_BOARD_REASON_LENGTH),
        ask: { text: words, source: `owner (agenda !${answer.id})` },
        ...(carried === undefined ? {} : { attachments: carried }),
      },
      answer,
      expect,
    );
  }

  /**
   * The card moved on the owner's answer: its ferret is told, so the agenda — now resting on it — gets its turn. A
   * Not good is told by the reopen itself, with the owner's words.
   */
  private async tellAnswered(
    task: BoardTask,
    gate: AgendaGate,
    decision: Extract<Decision, { kind: 'option' }>,
    answer: GateAnswer,
  ): Promise<void> {
    if (decision.option.outcome === 'reopen-with-agenda') return;
    const said = decision.note === null ? '' : `: ${decision.note}`;
    await this.ports.words
      .told(
        task,
        `${formatTaskRef(task)}: the owner said ${decision.option.label} on !${answer.id}${said}. Mark !${answer.id} done once nothing more is expected.`,
        `card-ask-${task.id}-${String(gate.entry)}-${answer.id}`,
      )
      .catch((error: unknown) =>
        this.ports.diagnostics.warn(`could not tell ${formatTaskRef(task)}'s ferret: ${errorText(error)}`),
      );
  }

  /** Files come only with a Not good, from this agenda's own session, and only where this daemon can carry them. */
  private filesRefusal(answer: GateAnswer, decision: Decision): GateRefusal | undefined {
    const files = answer.attachments;
    if (files === undefined) return undefined;
    if (decision.kind !== 'option' || decision.option.outcome !== 'reopen-with-agenda') {
      return { code: 'invalid', message: `only a Not good takes files, and ${answer.id} was answered otherwise` };
    }
    if (files.from !== answer.sessionId) {
      return { code: 'invalid', message: `the files for ${answer.id} must be uploaded to the session it is on` };
    }
    if (this.ports.files === undefined) {
      return {
        code: 'invalid',
        message: 'this daemon cannot carry files with an answer (update it: fy daemon update)',
      };
    }
    return undefined;
  }

  /**
   * The answer's files, moved to the card's ferret BEFORE the board is touched, so a file that cannot be carried
   * leaves the card where it is. The reopen then names them where the ferret holds them.
   */
  private async carried(
    task: BoardTask,
    answer: GateAnswer,
  ): Promise<BoardReopenAttachments | GateRefusal | undefined> {
    const files = answer.attachments;
    if (files === undefined || this.ports.files === undefined) return undefined;
    const to = effectiveAssignee(task);
    try {
      return { from: to, ids: [...(await this.ports.files.carry(files.from, to, files.ids))] };
    } catch (error) {
      return {
        code: 'not-moved',
        message: `${formatTaskRef(task)} was not moved: a file could not be carried to its ferret: ${errorText(error)}`,
      };
    }
  }

  /** "Not yet" with words: kept on the card as the owner's, and told to its ferret. The card stays where it is. */
  private async notYet(task: BoardTask, words: string, answer: GateAnswer): Promise<void> {
    const refusal = await this.act(
      task.id,
      { action: 'clarify', text: words, source: `owner (agenda !${answer.id})` },
      answer,
    );
    if (refusal !== undefined)
      this.ports.diagnostics.warn(`the owner's words on ${formatTaskRef(task)} were not kept: ${refusal.message}`);
    await this.ports.words
      .told(
        task,
        `${formatTaskRef(task)}: the owner is not ready to move it on yet: ${words}`,
        `gate-not-yet-${task.id}-${answer.id}`,
      )
      .catch((error: unknown) =>
        this.ports.diagnostics.warn(`could not tell ${formatTaskRef(task)}'s ferret: ${errorText(error)}`),
      );
  }

  /** One board act as the owner; the board's refusal as a gate refusal. */
  private async act(
    id: BoardTaskId,
    request: BoardTaskActionRequest,
    answer: GateAnswer,
    expect?: GateExpectation,
  ): Promise<GateRefusal | undefined> {
    try {
      await this.ports.board.act(id, request, answer.caller, expect);
      return undefined;
    } catch (error) {
      return { code: 'not-moved', message: `${formatTaskRef({ id })} was not moved: ${errorText(error)}` };
    }
  }
}

/** Whether an item carries this ask open. */
const holds = (item: AgendaItem, reference: string): boolean =>
  openCardAsks(item).some(ask => cardAskReference(ask) === reference);

const withSteps = (howToTest: string | undefined): { readonly howToTest?: string } =>
  howToTest === undefined ? {} : { howToTest };

/** What the owner's answer means on this gate. */
type Decision =
  | {
      readonly kind: 'option';
      readonly option: AgendaGateOption;
      readonly note: string | null;
      readonly words?: string;
    }
  | { readonly kind: 'not-yet'; readonly note: string | null; readonly words?: string };

/**
 * Everything an answer says, as the daemon reads it: the choice, the owner's normalized words and the files as sent,
 * as a digest kept with the answer, so a repeat is a replay only when it says the same.
 */
const receiptOf = (answer: GateAnswer, decision: Decision): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        answer.response,
        decision.words ?? '',
        answer.attachments === undefined ? null : [answer.attachments.from, answer.attachments.ids],
      ]),
    )
    .digest('hex');

const refused = (code: GateRefusal['code'], message: string): GateAnswerOutcome => ({
  handled: true,
  refused: { code, message },
});

/**
 * Reads the answer against the gate: a chosen label is its option (or "Not yet"); the owner's own words alone
 * (`other`) are the gate's Not good. Reopen-with-agenda needs words, from the note or the answer.
 */
const decide = (gate: AgendaGate, answer: GateAnswer): Decision | GateRefusal => {
  const note = answer.note?.trim() ?? '';
  const words = (text: string): { readonly words?: string } => (text === '' ? {} : { words: text });
  if (answer.response.kind === 'other') {
    const option = gateReopenOption(gate);
    if (option === undefined) {
      return {
        code: 'invalid',
        message: `${answer.id} is answered with one of its options: ${gate.options.map(each => each.label).join(', ')}`,
      };
    }
    const said = [answer.response.answer.trim(), note].filter(part => part !== '').join('\n\n');
    return { kind: 'option', option, note: note === '' ? null : note, ...words(said) };
  }
  if (answer.response.kind !== 'multiple-choice') {
    return { code: 'invalid', message: `${answer.id} asks you to choose one of its options` };
  }
  const choice = gateChoice(gate, answer.response.choice);
  if (choice.kind === 'unknown') {
    return { code: 'invalid', message: `${answer.id} has no option ${answer.response.choice}` };
  }
  if (choice.kind === 'not-yet') return { kind: 'not-yet', note: note === '' ? null : note, ...words(note) };
  if (choice.option.outcome === 'reopen-with-agenda' && note === '') {
    return {
      code: 'invalid',
      message: `say what is not good: ${choice.option.label} needs your words, and the ferret gets them`,
    };
  }
  return { kind: 'option', option: choice.option, note: note === '' ? null : note, ...words(note) };
};
