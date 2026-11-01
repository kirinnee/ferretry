/**
 * GATES ASK THE OWNER (docs/board.md § Gates ask the owner): the agenda item an owner-asked card raises when it
 * enters a gate lane, kept in line with the card whatever moved it, and the owner's answer applied to the card.
 *
 * - **Entering.** After every committed write of a card ({@link GateItems.written}, by any path: a move, a trigger,
 *   PR facts, a refile, `fy signal done`) and once at boot ({@link GateItems.backfill}), a card waiting at a gate
 *   has exactly one gate item: raised as the daemon on its ferret's agenda (the assignee's, else its owner ferret's,
 *   stopped or not) under `gate:<card>:<lane>:<entry>`, so raising it again is no change.
 * - **Leaving.** A card no longer at that gate (moved on by anyone, dropped, refiled) has its open gate item
 *   resolved quietly: "the card moved on".
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

export interface GateItemsDependencies {
  readonly agenda: GateAgenda;
  readonly board: GateBoard;
  readonly lanes: GateLanes;
  readonly words: GateWords;
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

/** The sessions whose agendas may hold a card's gate items: its assignee's first, then its owner ferret's. */
const sessionsOf = (task: Pick<BoardTask, 'assignee' | 'owner'>): readonly string[] => [
  ...new Set([effectiveAssignee(task), task.owner]),
];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class GateItems implements CardWriteObserver {
  /** Cards whose gate is being answered right now: their own writes are the answer's, not a card moving on. */
  private readonly answering = new Set<BoardTaskId>();
  /** One answer per card at a time: the tail of each card's queue of answers. */
  private readonly answers = new Map<BoardTaskId, Promise<unknown>>();

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
   * At boot: every card already waiting at a gate gets its one item, and every open gate item whose card moved on
   * while the daemon was down is resolved. Each card on its own; returns how many items it raised.
   */
  async backfill(): Promise<number> {
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
    const before = this.answers.get(cardId) ?? Promise.resolve();
    const turn = before.then(async () => await this.answerAlone(answer));
    const tail = turn.catch(() => undefined);
    this.answers.set(cardId, tail);
    try {
      return await turn;
    } finally {
      if (this.answers.get(cardId) === tail) this.answers.delete(cardId);
    }
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

  /** Brings one card's gate items in line with its lane; `true` when it raised one. */
  private async reconcile(card: GateCard): Promise<boolean> {
    const gate = gateOf(card, this.ports.lanes);
    const wanted = gate === undefined ? undefined : gateReference(gate);
    const sessions = sessionsOf(card.task);
    const open = await this.openItems(card.task.id, sessions);
    for (const stale of open.gates.filter(each => each.item.sourceRef !== wanted)) {
      await this.ports.agenda.resolve(stale.sessionId, stale.item.id, DAEMON, GATE_MOVED_ON);
    }
    if (gate === undefined) return false;
    const current = open.gates.find(each => each.item.sourceRef === wanted);
    if (current !== undefined) {
      // Already asked: brought up to date (an open PR said or unsaid), never raised a second time.
      await this.ports.agenda.raise(current.sessionId, gateRaise(gate, card.task), DAEMON);
      return false;
    }
    const raised = await this.raise(card.task, gate, sessions);
    // Back at a gate: the conversation the last Not good opened has done its work.
    if (raised) {
      for (const followup of open.followups) {
        await this.ports.agenda.resolve(
          followup.sessionId,
          followup.item.id,
          DAEMON,
          `the card is back in ${gate.laneName}`,
        );
      }
    }
    return raised;
  }

  /** Raises the gate item on the first of the card's sessions that takes it; `true` when one was created. */
  private async raise(task: BoardTask, gate: AgendaGate, sessions: readonly string[]): Promise<boolean> {
    const request: RaiseAgendaRequest = gateRaise(gate, task);
    const refusals: string[] = [];
    for (const sessionId of sessions) {
      const mutation = await this.ports.agenda.raise(sessionId, request, DAEMON);
      if (mutation.ok) return mutation.change === 'created';
      refusals.push(`${sessionId}: ${mutation.error.message}`);
    }
    this.ports.diagnostics.warn(`no gate item for ${formatTaskRef(task)} in ${gate.laneName}: ${refusals.join('; ')}`);
    return false;
  }

  /** The card's open gate items and follow-ups on its sessions' agendas. A board that cannot be read holds none. */
  private async openItems(
    cardId: BoardTaskId,
    sessions: readonly string[],
  ): Promise<{ readonly gates: readonly OpenItem[]; readonly followups: readonly OpenItem[] }> {
    const gates: OpenItem[] = [];
    const followups: OpenItem[] = [];
    for (const sessionId of sessions) {
      const listed = await this.ports.agenda.list(sessionId).catch(() => undefined);
      if (listed === undefined || !listed.ok) continue;
      for (const item of listed.value.items) {
        // Only the gate items' own producer: the daemon's `task` source (a gate item also carries its `gate`).
        if (item.raisedBy !== 'daemon' || item.source !== 'task') continue;
        if (item.gate !== undefined && parseGateReference(item.sourceRef)?.cardId === cardId)
          gates.push({ sessionId, item });
        else if (parseGateFollowupReference(item.sourceRef)?.cardId === cardId) followups.push({ sessionId, item });
      }
    }
    return { gates, followups };
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
