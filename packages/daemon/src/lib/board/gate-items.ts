/**
 * GATES ASK THE OWNER (docs/board.md § Gates ask the owner): the agenda item an owner-asked card raises when it
 * enters a gate lane, kept in line with the card whatever moved it, and the owner's answer applied to the card.
 *
 * - **Entering.** After every committed write of a card ({@link GateItems.written}, by any path: a move, a trigger,
 *   PR facts, a refile, `fy signal done`) and once at boot ({@link GateItems.backfill}), a card waiting at a gate
 *   has exactly one gate item: raised as the daemon on its ferret's agenda (the assignee's, else its owner ferret's,
 *   stopped or not) under `gate:<card>:<lane>:<entry>`, so raising it again is no change.
 * - **One per machine.** A card changes hands (reassigned, handed down) and its items stay where they were raised, so
 *   a card's gate items are looked for on EVERY agenda that ever held one, not only its ferrets' of today. One gate
 *   asks once across all of them: an open item elsewhere is MOVED to the card's ferret, carrying its snooze and its
 *   conversation, and closed where it was; a duplicate is closed; and a gate the owner already answered on any agenda
 *   is never asked again. A one-time sweep ({@link GateItems.backfill}) closed the duplicates raised before this held.
 * - **Leaving.** A card no longer at that gate (moved on by anyone, dropped, refiled) has its open gate item
 *   resolved quietly: "the card moved on".
 * - **Back at a gate.** The Not good conversations of EARLIER rounds are closed wherever they are, unless one is
 *   still going with the owner (their turn, or anything said since the card came back).
 * - **Answering** ({@link GateItems.answer}): only a human. The card moves FIRST, as the owner, through the board;
 *   only a move that went through closes the item, so an item is never answered while its card stayed put.
 *
 * An internal card (its lead's bookkeeping) never raises one: its owner ferret or a lead passes its gate itself.
 */
import {
  type AgendaGate,
  type AgendaId,
  type AgendaItem,
  type AgendaResponse,
  type AgendaSnapshot,
  type BoardTask,
  type BoardTaskActionRequest,
  type BoardTaskId,
  clipAtWord,
  formatTaskRef,
  gateChoice,
  gateFollowupReference,
  gateReference,
  gateReopenOption,
  MAX_AGENDA_SUBJECT_LENGTH,
  MAX_AGENDA_TITLE_LENGTH,
  MAX_BOARD_REASON_LENGTH,
  parseGateFollowupReference,
  parseGateReference,
  type AgendaGateOption,
} from '@ferretry/protocol';
import type { AgendaQueryResult } from '../agenda/service.ts';
import type { AgendaActor, AgendaMutation, RaiseAgendaRequest } from '../agenda/state-machine.ts';
import { type BoardCaller, effectiveAssignee } from './authority.ts';
import { type GateCard, type GateLanes, gateMoveReason, gateOf, gateRaise } from './gate-policy.ts';
import type { CardWriteObserver } from './service.ts';

/** The agenda operations the gates use. */
interface GateAgenda {
  list(sessionId: string): Promise<AgendaQueryResult<AgendaSnapshot>>;
  raise(sessionId: string, request: RaiseAgendaRequest, actor: AgendaActor): Promise<AgendaMutation>;
  resolve(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation>;
  answer(
    sessionId: string,
    id: AgendaId,
    response: AgendaResponse,
    actor: AgendaActor,
    note?: string | null,
  ): Promise<AgendaMutation>;
}

/** The board as the gates read and write it: one card or every card, and the owner's act on one. */
export interface GateBoard {
  card(id: BoardTaskId): Promise<GateCard | undefined>;
  cards(): Promise<readonly GateCard[]>;
  /**
   * Applies one action as `caller`; throws the board's refusal. `expect` is checked in the same write: the card must
   * still sit in that lane by that entry, or nothing is written.
   */
  act(id: BoardTaskId, request: BoardTaskActionRequest, caller: BoardCaller, expect?: GateExpectation): Promise<void>;
}

/** Tells a card's ferret the owner's words that moved nothing ("Not yet" with words), through the reopen ladder. */
interface GateWords {
  told(task: BoardTask, message: string, key: string): Promise<void>;
}

/** Every session on this machine whose agenda may hold a card's gate item: a card changes hands, its items do not. */
interface GateSessions {
  all(): Promise<readonly string[]>;
}

/** Where the one-time sweep of duplicate gate items records that it ran: once, for this daemon's home. */
export interface GateItemsMigrationMarker {
  ran(): Promise<boolean>;
  /** Records that it ran, and every item it closed (`<session> !A<n>`). */
  record(at: string, closed: readonly string[]): Promise<void>;
}

export interface GateItemsDependencies {
  readonly agenda: GateAgenda;
  readonly board: GateBoard;
  readonly lanes: GateLanes;
  readonly words: GateWords;
  readonly sessions: GateSessions;
  readonly marker: GateItemsMigrationMarker;
  readonly now: () => string;
  readonly diagnostics: { warn(message: string): void };
}

/** What answering a gate item came to. */
export type GateAnswerOutcome =
  /** Not a gate item (or no longer open): answer it as any other. */
  | { readonly handled: false }
  | { readonly handled: true; readonly mutation: AgendaMutation }
  | { readonly handled: true; readonly refused: GateRefusal };

export interface GateRefusal {
  readonly code: 'forbidden' | 'invalid' | 'moved-on' | 'not-moved';
  readonly message: string;
}

/** One gate answer, as the agenda route received it. */
export interface GateAnswer {
  readonly sessionId: string;
  readonly id: AgendaId;
  readonly response: AgendaResponse;
  readonly note?: string | null | undefined;
  readonly actor: AgendaActor;
  /** Who the board records the move as: the owner's app, or the admin token at the machine. */
  readonly caller: BoardCaller;
  /**
   * Whether this human may move the card at all — a paired device needs the board's own grant — asked only once the
   * item is known to be a gate, before the board is touched: the refusal's words, or `undefined` when it may.
   */
  readonly permitted?: () => string | undefined;
}

/** Where an answer expects the card to be when its move is written: the gate's lane, by the entry it asked about. */
export interface GateExpectation {
  readonly laneId: string;
  readonly entry: number;
}

/** The resolution note an item gets when its card left the gate some other way. */
export const GATE_MOVED_ON = 'the card moved on';

const DAEMON: AgendaActor = { kind: 'daemon', cause: 'system' };

interface OpenItem {
  readonly sessionId: string;
  readonly item: AgendaItem;
}

/** A card's gate items and follow-ups on the agendas that hold any, and the gates already asked and closed. */
interface HeldItems {
  readonly gates: readonly OpenItem[];
  readonly followups: readonly OpenItem[];
  /**
   * The `gate:` references of the card's gate items the OWNER closed (answered, or said Not needed): each of those
   * gates has been asked. One the daemon closed itself (moved, a duplicate) is not an answer, so it never stops one.
   */
  readonly asked: ReadonlySet<string>;
}

/** The sessions whose agendas a card's gate item belongs on: its assignee's first, then its owner ferret's. */
const sessionsOf = (task: Pick<BoardTask, 'assignee' | 'owner'>): readonly string[] => [
  ...new Set([effectiveAssignee(task), task.owner]),
];

/** The card a gate item or a follow-up (the daemon's `task` source) is about, else `undefined`. */
const gateCardOf = (item: AgendaItem): string | undefined => {
  if (item.raisedBy !== 'daemon' || item.source !== 'task') return undefined;
  return parseGateReference(item.sourceRef)?.cardId ?? parseGateFollowupReference(item.sourceRef)?.cardId;
};

/** The resolution note of a gate item another one stands in for: where the card's one gate item is now. */
const supersededNote = (kept: OpenItem): string =>
  `the card changed hands; its gate item is now !${kept.item.id} on ${kept.sessionId}'s agenda`;

/** The newer of two items of one gate: the one raised (or woken) later, the later session on a tie. */
const newer = (one: OpenItem, other: OpenItem): OpenItem => {
  const order = Date.parse(other.item.waitingSince) - Date.parse(one.item.waitingSince);
  return order > 0 || (order === 0 && other.sessionId > one.sessionId) ? other : one;
};

/** Whether a follow-up is still going with the owner: on their turn, or with anything said after `since`. */
const talking = (item: AgendaItem, since: number): boolean =>
  (item.waitingOn === undefined && item.parked === undefined) || lastActivity(item) > since;

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

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class GateItems implements CardWriteObserver {
  /** Cards whose gate is being answered right now: their own writes are the answer's, not a card moving on. */
  private readonly answering = new Set<BoardTaskId>();
  /** One answer per card at a time: the tail of each card's queue of answers. */
  private readonly answers = new Map<BoardTaskId, Promise<unknown>>();
  /** One pass over a card's gate items at a time, so two writes of one card never raise its gate twice. */
  private readonly passes = new Map<BoardTaskId, Promise<unknown>>();
  /** Which agendas hold (or held) each card's gate items and follow-ups: read once from all, then kept as raised. */
  private readonly holders = new Map<string, Set<string>>();
  /** The one read of every agenda behind {@link holders}, once it has started. */
  private scanning: Promise<void> | undefined;

  constructor(private readonly ports: GateItemsDependencies) {}

  /** Whether this open item is a card's gate item. */
  async isGate(sessionId: string, id: AgendaId): Promise<boolean> {
    const listed = await this.ports.agenda.list(sessionId);
    return listed.ok && listed.value.items.some(each => each.id === id && each.gate !== undefined);
  }

  /** A card was written: its gate item follows its lane. Never rejects. */
  async written(id: BoardTaskId): Promise<void> {
    if (this.answering.has(id)) return;
    const card = await this.ports.board.card(id).catch(() => undefined);
    if (card === undefined) return;
    await this.reconcile(card).catch((error: unknown) =>
      this.ports.diagnostics.warn(`the gate item of ${formatTaskRef({ id })} could not follow it: ${errorText(error)}`),
    );
  }

  /**
   * At boot: the duplicates sweep runs if it never has, every card already waiting at a gate gets its one item, and
   * every open gate item whose card moved on while the daemon was down is resolved. Each card on its own; returns
   * how many items it raised.
   */
  async backfill(): Promise<number> {
    await this.sweepDuplicates().catch((error: unknown) =>
      this.ports.diagnostics.warn(`the sweep of duplicate gate items failed: ${errorText(error)}`),
    );
    const cards = await this.ports.board.cards();
    let raised = 0;
    for (const card of cards) {
      try {
        if (await this.reconcile(card)) raised += 1;
      } catch (error) {
        this.ports.diagnostics.warn(
          `the gate item of ${formatTaskRef(card.task)} could not be raised: ${errorText(error)}`,
        );
      }
    }
    return raised;
  }

  /**
   * The owner's answer to a gate item: the card moves first, as the owner, and only then is the item answered. A
   * refusal leaves the item open and says why. `handled: false` for any item that is not an open gate item.
   */
  async answer(answer: GateAnswer): Promise<GateAnswerOutcome> {
    const listed = await this.ports.agenda.list(answer.sessionId);
    const cardId = listed.ok ? listed.value.items.find(each => each.id === answer.id)?.gate?.cardId : undefined;
    if (cardId === undefined) return { handled: false };
    // Answers to one card's gate take turns: the second reads the board the first one left.
    return await serially(this.answers, cardId, async () => await this.answerAlone(answer));
  }

  private async answerAlone(answer: GateAnswer): Promise<GateAnswerOutcome> {
    const listed = await this.ports.agenda.list(answer.sessionId);
    const item = listed.ok ? listed.value.items.find(each => each.id === answer.id) : undefined;
    const gate = item?.gate;
    if (item === undefined || gate === undefined) return { handled: false };
    if (answer.actor.kind !== 'human') {
      return refused(
        'forbidden',
        `only the owner answers ${answer.id}: it decides where ${formatTaskRef({ id: gate.cardId })} goes next`,
      );
    }
    const denied = answer.permitted?.();
    if (denied !== undefined) return refused('forbidden', denied);
    const decision = decide(gate, answer);
    if ('code' in decision) return { handled: true, refused: decision };
    const card = await this.ports.board.card(gate.cardId);
    const here = card === undefined ? undefined : gateOf(card, this.ports.lanes);
    if (card === undefined || here === undefined || gateReference(here) !== item.sourceRef) {
      await this.ports.agenda.resolve(answer.sessionId, answer.id, DAEMON, GATE_MOVED_ON).catch(() => undefined);
      return refused(
        'moved-on',
        `${formatTaskRef({ id: gate.cardId })} is no longer in ${gate.laneName}, so nothing was moved; ${answer.id} is closed`,
      );
    }
    this.answering.add(card.task.id);
    try {
      const applied = await this.apply(card, gate, decision, answer);
      if (applied !== undefined) return { handled: true, refused: applied };
      const mutation = await this.ports.agenda.answer(
        answer.sessionId,
        answer.id,
        answer.response,
        answer.actor,
        decision.note,
      );
      return { handled: true, mutation };
    } finally {
      this.answering.delete(card.task.id);
      await this.written(card.task.id);
    }
  }

  /** Brings one card's gate items in line with its lane, one pass per card at a time; `true` when it raised one. */
  private async reconcile(card: GateCard): Promise<boolean> {
    return await serially(this.passes, card.task.id, async () => await this.reconcileAlone(card));
  }

  private async reconcileAlone(card: GateCard): Promise<boolean> {
    const { task } = card;
    const gate = gateOf(card, this.ports.lanes);
    const wanted = gate === undefined ? undefined : gateReference(gate);
    const home = sessionsOf(task);
    const held = await this.held(task.id, home);
    for (const stale of held.gates.filter(each => each.item.sourceRef !== wanted)) {
      await this.ports.agenda.resolve(stale.sessionId, stale.item.id, DAEMON, GATE_MOVED_ON);
    }
    if (gate === undefined) return false;
    const asking = held.gates.filter(each => each.item.sourceRef === wanted);
    let raised = false;
    if (asking.length > 0) await this.keepOne(task, gate, home, asking);
    // A gate asks once on every agenda: one the owner answered (or set aside) anywhere is never asked again.
    else if (!held.asked.has(gateReference(gate))) raised = await this.raise(task, gate, home);
    await this.closeEarlierRounds(task, gate, held.followups);
    return raised;
  }

  /**
   * The gate is asked already, on one agenda or more, and ONE item stays: the one on the card's ferret's agenda,
   * brought up to date; else the newest, moved there as it stood. Every other one is closed, saying which one stands.
   */
  private async keepOne(
    task: BoardTask,
    gate: AgendaGate,
    home: readonly string[],
    asking: readonly OpenItem[],
  ): Promise<void> {
    const request = gateRaise(gate, task);
    const atHome = home.flatMap(sessionId => asking.filter(each => each.sessionId === sessionId))[0];
    const newest = asking.reduce(newer);
    const kept = atHome ?? (await this.move(task, gate, request, newest, home)) ?? newest;
    // Already asked: brought up to date (an open PR said or unsaid), never raised a second time.
    if (asking.includes(kept)) await this.ports.agenda.raise(kept.sessionId, request, DAEMON);
    for (const other of asking.filter(each => each !== kept)) {
      await this.ports.agenda.resolve(other.sessionId, other.item.id, DAEMON, supersededNote(kept));
    }
  }

  /**
   * The gate raised on the card's ferret's agenda as `from` stood — its snooze, whose turn it is, its conversation —
   * so the owner is not asked afresh. The new item, or `undefined` when no agenda of the card's took it.
   */
  private async move(
    task: BoardTask,
    gate: AgendaGate,
    request: RaiseAgendaRequest,
    from: OpenItem,
    home: readonly string[],
  ): Promise<OpenItem | undefined> {
    const refusals: string[] = [];
    for (const sessionId of home) {
      const mutation = await this.ports.agenda.raise(sessionId, { ...request, carried: from.item }, DAEMON);
      if (mutation.ok && mutation.item !== undefined) {
        this.remember(task.id, sessionId);
        return { sessionId, item: mutation.item };
      }
      refusals.push(`${sessionId}: ${mutation.ok ? 'already asked there' : mutation.error.message}`);
    }
    this.ports.diagnostics.warn(
      `the gate item of ${formatTaskRef(task)} in ${gate.laneName} stays on ${from.sessionId}'s agenda: ${refusals.join('; ')}`,
    );
    return undefined;
  }

  /**
   * Back at a gate: the Not good conversations of EARLIER rounds have done their work, wherever they are — but never
   * one still going with the owner: on the owner's turn, or with anything said since the card came back.
   */
  private async closeEarlierRounds(task: BoardTask, gate: AgendaGate, followups: readonly OpenItem[]): Promise<void> {
    const back = task.history.find(each => each.seq === gate.entry)?.at;
    if (back === undefined) return;
    for (const followup of followups) {
      const round = parseGateFollowupReference(followup.item.sourceRef)?.entry ?? gate.entry;
      if (round >= gate.entry || talking(followup.item, Date.parse(back))) continue;
      await this.ports.agenda.resolve(
        followup.sessionId,
        followup.item.id,
        DAEMON,
        `the card is back in ${gate.laneName}`,
      );
    }
  }

  /** Raises the gate item on the first of the card's sessions that takes it; `true` when one was created. */
  private async raise(task: BoardTask, gate: AgendaGate, sessions: readonly string[]): Promise<boolean> {
    const request: RaiseAgendaRequest = gateRaise(gate, task);
    const refusals: string[] = [];
    for (const sessionId of sessions) {
      const mutation = await this.ports.agenda.raise(sessionId, request, DAEMON);
      if (mutation.ok) {
        this.remember(task.id, sessionId);
        return mutation.change === 'created';
      }
      refusals.push(`${sessionId}: ${mutation.error.message}`);
    }
    this.ports.diagnostics.warn(`no gate item for ${formatTaskRef(task)} in ${gate.laneName}: ${refusals.join('; ')}`);
    return false;
  }

  /**
   * The card's gate items and follow-ups, on its ferrets' agendas and on every other that ever held one of its items:
   * open ones, and the gates already asked and closed. An agenda that cannot be read holds none.
   */
  private async held(cardId: BoardTaskId, home: readonly string[]): Promise<HeldItems> {
    await this.scanned();
    const gates: OpenItem[] = [];
    const followups: OpenItem[] = [];
    const asked = new Set<string>();
    for (const sessionId of new Set([...home, ...(this.holders.get(cardId) ?? [])])) {
      const listed = await this.ports.agenda.list(sessionId).catch(() => undefined);
      if (listed === undefined || !listed.ok) continue;
      for (const item of listed.value.items) {
        if (gateCardOf(item) !== cardId) continue;
        if (item.gate !== undefined) gates.push({ sessionId, item });
        else followups.push({ sessionId, item });
      }
      for (const item of listed.value.resolved) {
        if (item.resolvedBy !== 'human' || item.gate === undefined || item.sourceRef === null) continue;
        if (gateCardOf(item) === cardId) asked.add(item.sourceRef);
      }
    }
    return { gates, followups, asked };
  }

  /** Every agenda read once for the cards whose items it holds; a pass that could not list them is tried again. */
  private async scanned(): Promise<void> {
    this.scanning ??= this.scan().catch((error: unknown) => {
      this.scanning = undefined;
      this.ports.diagnostics.warn(`the agendas holding gate items could not be listed: ${errorText(error)}`);
    });
    await this.scanning;
  }

  private async scan(): Promise<void> {
    for (const sessionId of await this.ports.sessions.all()) {
      const listed = await this.ports.agenda.list(sessionId).catch(() => undefined);
      if (listed === undefined || !listed.ok) continue;
      for (const item of [...listed.value.items, ...listed.value.resolved]) {
        const cardId = gateCardOf(item);
        if (cardId !== undefined) this.remember(cardId, sessionId);
      }
    }
  }

  /** `sessionId`'s agenda holds one of the card's gate items or follow-ups: where to look after it changes hands. */
  private remember(cardId: string, sessionId: string): void {
    const sessions = this.holders.get(cardId) ?? new Set<string>();
    sessions.add(sessionId);
    this.holders.set(cardId, sessions);
  }

  /**
   * THE ONE-TIME SWEEP (B138): before a card's gate items were looked for on every agenda, each change of hands asked
   * the gate again on the new ferret's. Every gate asked on more than one agenda keeps its NEWEST item, and the others
   * are closed saying which one stands. Once: the marker is written only when every agenda was read and every
   * duplicate closed, and a start that finds it does nothing.
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
        if (item.gate === undefined || item.sourceRef === null || gateCardOf(item) === undefined) continue;
        byGate.set(item.sourceRef, [...(byGate.get(item.sourceRef) ?? []), { sessionId, item }]);
      }
    }
    const closed: string[] = [];
    for (const items of byGate.values()) {
      const kept = items.reduce(newer);
      for (const other of items.filter(each => each !== kept)) {
        const mutation = await this.ports.agenda
          .resolve(other.sessionId, other.item.id, DAEMON, `closed as a duplicate: ${supersededNote(kept)}`)
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
    const refusal = await this.act(
      task.id,
      {
        action: 'reopen',
        to: target.lane.id,
        reason: clipAtWord(words, MAX_BOARD_REASON_LENGTH),
        ask: { text: words, source: `owner (Inbox, !${answer.id})` },
      },
      answer,
      expect,
    );
    // Only a card that really went back gets its conversation: a refused Not good opens none, and uses none up.
    if (refusal === undefined) await this.followup(task, gate, words);
    return refusal;
  }

  /** "Not yet" with words: kept on the card as the owner's, and told to its ferret. The card stays where it is. */
  private async notYet(task: BoardTask, words: string, answer: GateAnswer): Promise<void> {
    const refusal = await this.act(
      task.id,
      { action: 'clarify', text: words, source: `owner (Inbox, !${answer.id})` },
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

  /**
   * The ONE conversation a Not good opens, on the ferret's turn (it discusses the rework with the owner), raised as
   * the daemon on behalf of the card's ferret. `undefined` when it could not be raised: the reopen goes on.
   */
  private async followup(task: BoardTask, gate: AgendaGate, words: string): Promise<OpenItem | undefined> {
    const sessionId = effectiveAssignee(task);
    const ref = formatTaskRef(task);
    const mutation = await this.ports.agenda.raise(
      sessionId,
      {
        source: 'task',
        sourceRef: gateFollowupReference({ cardId: task.id, entry: gate.entry }),
        title: clipAtWord(`Not good: ${task.title}`, MAX_AGENDA_TITLE_LENGTH),
        kind: 'reply',
        ask: { kind: 'open-question' },
        subject: clipAtWord(
          `What should change in ${ref}? You said: ${words.replaceAll(/\s+/gu, ' ')}`,
          MAX_AGENDA_SUBJECT_LENGTH,
        ),
        why: `You said ${ref} is not good yet, so it went back for rework.`,
        howToResolve: 'Talk it over with the ferret here; it closes this once the rework is clear.',
        task: { id: task.id },
        discussion: true,
      },
      DAEMON,
    );
    if (!mutation.ok || mutation.item === undefined) {
      this.ports.diagnostics.warn(
        `no follow-up conversation for ${ref}: ${mutation.ok ? 'it was not raised' : mutation.error.message}`,
      );
      return undefined;
    }
    this.remember(task.id, sessionId);
    return { sessionId, item: mutation.item };
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

/** What the owner's answer means on this gate. */
type Decision =
  | {
      readonly kind: 'option';
      readonly option: AgendaGateOption;
      readonly note: string | null;
      readonly words?: string;
    }
  | { readonly kind: 'not-yet'; readonly note: string | null; readonly words?: string };

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
