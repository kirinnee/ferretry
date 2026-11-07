/**
 * CARDS SHOW PROGRESS; THEIR ASKS RIDE THE AGENDA (docs/board.md § Cards show progress; their asks ride the agenda).
 * A card never asks the owner itself. When an owner-asked card reaches a lane whose stage is a gate (OK to build, or
 * Done / Not good), the Board raises ONE obligation through Asks (source `card`, entry `gate:<card>:<lane>:<entry>`,
 * redesign §7.4 rule 4), keeps it in line with the card whatever moved it, and applies the owner's answer to the card.
 *
 * - **Attaching.** After every committed write of a card ({@link GateItems.written}, by any path: a move, a trigger,
 *   PR facts, a refile, `fy signal done`) and once at boot ({@link GateItems.backfill}), a card at a gate has its ask
 *   open once. Raising is idempotent by `(source, entry)`, so a second look raises nothing new; an ask the owner
 *   answered is never asked again (`CardObligations.answered`).
 * - **Leaving.** A card no longer at that gate (moved on by the owner on the Board, dropped, refiled) has its open ask
 *   withdrawn quietly. A try-it gate whose card is blocked takes its ask back until it is unblocked.
 * - **Answering** ({@link GateItems.answer}): only a human, through Asks' own answer route (which Gate admitted). Asks
 *   records the answer and announces it (`asks.answered`); this applies it BY ANSWER ID, once: the card moves FIRST, as
 *   the owner, through the board, expecting to find it at that gate by that entry, so a replayed answer finds the card
 *   gone and moves nothing. The ferret is then told.
 *
 * An internal card (its lead's bookkeeping) never asks: its owner ferret or a lead passes its gate itself. Nor does a
 * sub-card at a lane the owner tries things in: the owner tests the parent.
 */
import { createHash } from 'node:crypto';
import type { AskDraft } from '@ferretry/core-asks/contract';
import {
  type BoardReopenAttachments,
  type Card,
  type CardActionRequest,
  type CardGate,
  type CardGateOption,
  type CardId,
  clipAtWord,
  formatCardRef,
  gateChoice,
  gateReference,
  gateReopenOption,
  type GuideProduct,
  MAX_BOARD_REASON_LENGTH,
  parseGateReference,
} from '../../../contract/index.ts';
import { type BoardCaller, effectiveAssignee } from './authority.ts';
import {
  cardAskDraft,
  type GateCard,
  type GateLanes,
  gateMoveReason,
  gateOf,
  nothingToTryReason,
  tryItVerdict,
} from './gate-policy.ts';
import type { CardWriteObserver } from './service.ts';

/** An open `card` ask, as the obligations port reports it. */
export interface OpenCardAskEntry {
  /** The Asks entry id: `gate:<card>:<lane>:<entry>`. */
  readonly entry: string;
  /** The ask's id on its ferret's ledger (`A12`). */
  readonly ask: string;
  /** The ferret whose ledger holds it. */
  readonly ferret: string;
  readonly cardId: CardId;
}

/**
 * The `card` source's obligations in Asks, as the Board lib uses them. The adapter maps each onto `AsksApi` (raise,
 * close, open, answers) and onto the `AskAnswered` wake-up; the lib never imports a plugin.
 *
 * `raise` is idempotent by `(source, entry)`: a second raise of an entry that is open or answered changes nothing.
 */
export interface CardObligations {
  /** Raises the ask; `true` when it is new, `false` when that entry was already raised. */
  raise(draft: AskDraft): Promise<boolean>;
  /** Withdraws the open ask of `entry`; nothing when it is not open. */
  withdraw(entry: string, reason: 'withdrawn' | 'superseded'): Promise<void>;
  /** Every open `card` ask, or the open ones of one card. A read that fails THROWS: "not asking" would let a second ask through. */
  open(card?: CardId): Promise<readonly OpenCardAskEntry[]>;
  /** The entries of this card's asks the owner has already answered: each has been asked, for good. */
  answered(card: CardId): Promise<ReadonlySet<string>>;
}

/** The board as the card asks read and write it: one card or every card, and the owner's act on one. */
export interface GateBoard {
  card(id: CardId): Promise<GateCard | undefined>;
  cards(): Promise<readonly GateCard[]>;
  /**
   * Applies one action as `caller`; throws the board's refusal. `expect` is checked in the same write: the card must
   * still sit in that lane by that entry, or nothing is written.
   */
  act(id: CardId, request: CardActionRequest, caller: BoardCaller, expect?: GateExpectation): Promise<void>;
  /**
   * The daemon's own move of a card out of a try-it lane into the closed lane, reason beside it: the one pass of a gate
   * that is not the owner's. Written only while the card still sits at `expect`; `false` when it did not close.
   */
  closeNothingToTry(id: CardId, expect: GateExpectation, reason: string): Promise<boolean>;
}

/** Tells a card's ferret the owner's answer, through the reopen ladder. */
interface GateWords {
  told(task: Card, message: string, key: string): Promise<void>;
}

/** Where the files an answer carries are moved to the card's ferret, answering their ids as they are THERE; rejects when one cannot be carried. */
interface GateFiles {
  carry(from: string, to: string, ids: readonly string[]): Promise<readonly string[]>;
}

/**
 * Where the daemon asks the owner for a ferret: its home, the owner's own ferret at the root of its lineage — never a
 * helper.
 */
interface GateHomes {
  of(ferret: string): Promise<string>;
}

export interface GateItemsDependencies {
  readonly obligations: CardObligations;
  readonly board: GateBoard;
  readonly lanes: GateLanes;
  readonly words: GateWords;
  /** Absent where this daemon cannot carry files: an answer that brings some is refused. */
  readonly files?: GateFiles;
  readonly homes: GateHomes;
  /** This daemon's own product: only a PR of its release repository is "shipped in" it (the try-it guide). */
  readonly product?: GuideProduct;
  readonly diagnostics: { warn(message: string): void };
}

/** What answering a card ask came to. */
export type GateAnswerOutcome =
  /** Not an answer to a card ask. */
  | { readonly handled: false }
  /** The answer was applied (or repeats one that was): the card moved, or stayed for a Not yet. */
  | { readonly handled: true; readonly applied: true }
  | { readonly handled: true; readonly refused: GateRefusal };

export interface GateRefusal {
  readonly code: 'forbidden' | 'invalid' | 'moved-on' | 'not-moved';
  readonly message: string;
}

/** One answer to a card ask, as the adapter read it from Asks (`asks.answered` -> `answers`). */
export interface GateAnswer {
  /** The answer's own id: each answer is applied once, by this id. */
  readonly answerId: string;
  /** The ask on its ferret's ledger (`!A12`). */
  readonly ask: { readonly ferret: string; readonly id: string };
  /** The ask's entry id: `gate:<card>:<lane>:<entry>`. */
  readonly entry: string;
  /** The chosen option label; absent when the owner answered in words alone. */
  readonly choice?: string | undefined;
  /** The owner's words: a note beside a choice, or the answer itself when no choice was made. */
  readonly text?: string | undefined;
  /** Files the owner brings with a Not good, uploaded to THIS ask's ferret (`from` is its ferret). */
  readonly attachments?: BoardReopenAttachments | undefined;
  /** Whether the answerer is the owner (a device or the host). Only a human answers a card ask. */
  readonly human: boolean;
  /** Who the board records the move as: the owner's app, or the admin token at the machine. */
  readonly caller: BoardCaller;
}

/** Where a card's ask is open now. */
export interface GateAsking {
  readonly ferret: string;
  readonly id: string;
}

/** Where an answer expects the card to be when its move is written: the gate's lane, by the entry it asked about. */
export interface GateExpectation {
  readonly laneId: string;
  readonly entry: number;
}

/** Runs `work` once every earlier one queued under `key` has settled: one at a time per key. */
const serially = async <T>(
  queues: Map<CardId, Promise<unknown>>,
  key: CardId,
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

export class GateItems implements CardWriteObserver {
  /** Cards whose ask is being answered right now: their own writes are the answer's, not a card moving on. */
  private readonly answering = new Set<CardId>();
  /** One answer per card at a time: the tail of each card's queue of answers. */
  private readonly answers = new Map<CardId, Promise<unknown>>();
  /** One pass over a card's asks at a time, so two writes of one card never raise its ask twice. */
  private readonly passes = new Map<CardId, Promise<unknown>>();
  /** The answers already applied in this run: a replay of one is a no-op even before the card is read. */
  private readonly applied = new Set<string>();

  constructor(private readonly ports: GateItemsDependencies) {}

  /** A card was written: its ask follows its lane. Never rejects. */
  async written(id: CardId): Promise<void> {
    if (this.answering.has(id)) return;
    const card = await this.ports.board.card(id).catch(() => undefined);
    if (card === undefined) return;
    await this.reconcile(card).catch((error: unknown) =>
      this.ports.diagnostics.warn(`the ask of ${formatCardRef({ id })} could not follow it: ${errorText(error)}`),
    );
  }

  /**
   * At boot: every card's ask is brought in line with its lane — one at a gate gets its ask, one whose card moved on
   * while the daemon was down loses it. Each card on its own; returns how many asks it raised.
   */
  async backfill(): Promise<number> {
    return await this.reconcileAll(card => card);
  }

  /** Every card at a gate is looked at again, and asks nothing is waiting for are closed; returns how many asks it raised. */
  async sweep(): Promise<number> {
    const raised = await this.reconcileAll(card => (gateOf(card, this.ports.lanes) === undefined ? undefined : card));
    await this.closeStrays().catch((error: unknown) =>
      this.ports.diagnostics.warn(`the sweep of stray card asks failed: ${errorText(error)}`),
    );
    return raised;
  }

  private async reconcileAll(choose: (card: GateCard) => GateCard | undefined): Promise<number> {
    let raised = 0;
    for (const card of (await this.ports.board.cards()).map(choose)) {
      if (card === undefined) continue;
      try {
        if (await this.reconcile(card)) raised += 1;
      } catch (error) {
        this.ports.diagnostics.warn(`the ask of ${formatCardRef(card.task)} could not be put: ${errorText(error)}`);
      }
    }
    return raised;
  }

  /**
   * The owner's answer to a card ask: the card moves first, as the owner, and a refusal says why. `handled: false` for
   * an entry that is not a gate's. Applied once per answer id.
   */
  async answer(answer: GateAnswer): Promise<GateAnswerOutcome> {
    const reference = parseGateReference(answer.entry);
    if (reference === undefined) return { handled: false };
    if (this.applied.has(answer.answerId)) return { handled: true, applied: true };
    // Answers to one card take turns: the second reads the board the first one left.
    return await serially(this.answers, reference.cardId, async () => await this.answerAlone(answer, reference.cardId));
  }

  private async answerAlone(answer: GateAnswer, cardId: CardId): Promise<GateAnswerOutcome> {
    if (this.applied.has(answer.answerId)) return { handled: true, applied: true };
    if (!answer.human) {
      return refused(
        'forbidden',
        `only the owner answers !${answer.ask.id}'s question: it decides where ${formatCardRef({ id: cardId })} goes next`,
      );
    }
    const card = await this.ports.board.card(cardId);
    const here = card === undefined ? undefined : gateOf(card, this.ports.lanes);
    if (card === undefined || here === undefined || gateReference(here) !== answer.entry) {
      await this.ports.obligations.withdraw(answer.entry, 'withdrawn').catch(() => undefined);
      return refused(
        'moved-on',
        `${formatCardRef({ id: cardId })} is no longer at that question, so nothing was moved`,
      );
    }
    const decision = decide(here, answer);
    if ('code' in decision) return { handled: true, refused: decision };
    const unfit = this.filesRefusal(answer, decision);
    if (unfit !== undefined) return { handled: true, refused: unfit };
    this.answering.add(card.task.id);
    try {
      const failed = await this.apply(card, here, decision, answer);
      if (failed !== undefined) return { handled: true, refused: failed };
      this.applied.add(answer.answerId);
      if (decision.kind === 'option') await this.tellAnswered(card.task, here, decision, answer);
      return { handled: true, applied: true };
    } finally {
      this.answering.delete(card.task.id);
      await this.written(card.task.id);
    }
  }

  /** Brings one card's ask in line with its lane, one pass per card at a time; `true` when it raised a new ask. */
  private async reconcile(card: GateCard): Promise<boolean> {
    return await serially(this.passes, card.task.id, async () => await this.reconcileAlone(card));
  }

  private async reconcileAlone(card: GateCard): Promise<boolean> {
    const { task } = card;
    const seen = gateOf(card, this.ports.lanes);
    const asked = await this.ports.obligations.answered(task.id);
    // At a try-it lane the daemon first asks whether there is anything to try (`tryItVerdict`).
    // A gate the owner already answered (a Not yet) is never closed under them: that ask was made, for good.
    const verdict =
      seen === undefined || asked.has(gateReference(seen))
        ? undefined
        : tryItVerdict({ ...task, blockedBy: card.blockedBy, building: card.building }, seen);
    // Nothing to try: the card closes, so what follows is the card as it stands NOW, past that gate.
    const closed = seen !== undefined && verdict?.kind === 'nothing' && (await this.closeNothing(card, seen, verdict.why));
    if (verdict?.kind === 'nothing' && !closed) return false;
    const gate = closed ? undefined : seen;
    // Blocked: the card is not ready to try, so nothing is asked, and an ask still waiting for the owner is taken back
    // (the card stays where it is; the next look after it is unblocked asks again).
    const wanted = gate === undefined || verdict?.kind === 'wait' ? undefined : gateReference(gate);
    // Every open ask of this card but the one its lane asks now goes.
    for (const open of await this.ports.obligations.open(task.id)) {
      if (open.entry !== wanted) await this.ports.obligations.withdraw(open.entry, 'withdrawn');
    }
    if (gate === undefined || wanted === undefined) return false;
    if (asked.has(wanted)) return false;
    const ferret = (await this.askersOf(task))[0] ?? task.owner;
    return await this.ports.obligations.raise(cardAskDraft(gate, task, ferret, this.ports.product));
  }

  /**
   * The daemon closes a card with nothing to try, with one plain reason in its history and no question. `true` once the
   * card is closed; `false` when it moved on first (the next look reads it as it is). The card's own write is not a
   * reason to look again, so it is not read as a card moving on while it is written.
   */
  private async closeNothing(card: GateCard, gate: CardGate, why: string): Promise<boolean> {
    this.answering.add(card.task.id);
    try {
      return await this.ports.board.closeNothingToTry(
        card.task.id,
        { laneId: gate.laneId, entry: gate.entry },
        nothingToTryReason(why),
      );
    } finally {
      this.answering.delete(card.task.id);
    }
  }

  /** The ferrets a card's ask belongs to: the home of its assignee first, then the home of its owner ferret. */
  private async askersOf(task: Pick<Card, 'assignee' | 'owner'>): Promise<readonly string[]> {
    const homes = await Promise.all(
      [effectiveAssignee(task), task.owner].map(async each => await this.ports.homes.of(each).catch(() => each)),
    );
    return [...new Set(homes)];
  }

  /**
   * Where this card's ask is open now, or `undefined` when it is not. A board or Asks that cannot be read THROWS:
   * "not asking" would let a second ask through.
   */
  async asking(cardId: CardId): Promise<GateAsking | undefined> {
    const card = await this.ports.board.card(cardId);
    const gate = card === undefined ? undefined : gateOf(card, this.ports.lanes);
    if (card === undefined || gate === undefined) return undefined;
    const wanted = gateReference(gate);
    const found = (await this.ports.obligations.open(cardId)).find(each => each.entry === wanted);
    return found === undefined ? undefined : { ferret: found.ferret, id: found.ask };
  }

  /**
   * The sweep for stray and duplicate asks (docs/agenda.md § One ask per thing, in the Board's own terms): an open
   * `card` ask whose card is gone or no longer at that gate is withdrawn; a card with two open asks keeps the one for
   * the gate it is at now (or the newest entry) and the other goes. Raising is idempotent by entry, so a twin of ONE
   * entry cannot exist; this catches the asks of different entries a missed write left behind.
   */
  private async closeStrays(): Promise<void> {
    const byCard = new Map<CardId, OpenCardAskEntry[]>();
    for (const open of await this.ports.obligations.open())
      byCard.set(open.cardId, [...(byCard.get(open.cardId) ?? []), open]);
    for (const [cardId, opens] of byCard) {
      const card = await this.ports.board.card(cardId).catch(() => undefined);
      const gate = card === undefined ? undefined : gateOf(card, this.ports.lanes);
      const wanted = gate === undefined ? undefined : gateReference(gate);
      const newest = (entry: string): number => parseGateReference(entry)?.entry ?? 0;
      const keeper =
        wanted !== undefined && opens.some(each => each.entry === wanted)
          ? wanted
          : [...opens].sort((left, right) => newest(right.entry) - newest(left.entry))[0]?.entry;
      for (const open of opens) {
        const stale = card === undefined || gate === undefined || open.entry !== keeper;
        if (stale && !(await this.isBeingAnswered(cardId))) await this.ports.obligations.withdraw(open.entry, 'superseded');
      }
    }
  }

  private async isBeingAnswered(cardId: CardId): Promise<boolean> {
    return this.answering.has(cardId);
  }

  /** Moves the card as the answer says; a refusal when the board would not. */
  private async apply(
    card: GateCard,
    gate: CardGate,
    decision: Decision,
    answer: GateAnswer,
  ): Promise<GateRefusal | undefined> {
    const { task, laneSet } = card;
    if (decision.kind === 'not-yet') {
      if (decision.words !== undefined) await this.notYet(task, decision.words, answer);
      return undefined;
    }
    if (laneSet === null) return { code: 'not-moved', message: `${formatCardRef(task)} has no lanes any more` };
    const target = this.ports.lanes.outcomeLane(laneSet, task.workflow, gate.laneId, decision.option.id);
    if (!target.ok) return { code: 'not-moved', message: `${formatCardRef(task)} was not moved: ${target.message}` };
    const expect: GateExpectation = { laneId: gate.laneId, entry: gate.entry };
    if (decision.option.outcome !== 'reopen-with-ask') {
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
    // The reopen tells the card's ferret the owner's words; the talk about the rework stays on THIS ask's ledger.
    return await this.act(
      task.id,
      {
        action: 'reopen',
        to: target.lane.id,
        reason: clipAtWord(words, MAX_BOARD_REASON_LENGTH),
        ask: { text: words, source: `owner (ask !${answer.ask.id})` },
        ...(carried === undefined ? {} : { attachments: carried }),
      },
      answer,
      expect,
    );
  }

  /** The card moved on the owner's answer: its ferret is told. A Not good is told by the reopen itself, with the owner's words. */
  private async tellAnswered(
    task: Card,
    gate: CardGate,
    decision: Extract<Decision, { kind: 'option' }>,
    answer: GateAnswer,
  ): Promise<void> {
    if (decision.option.outcome === 'reopen-with-ask') return;
    const said = decision.note === null ? '' : `: ${decision.note}`;
    await this.ports.words
      .told(
        task,
        `${formatCardRef(task)}: the owner said ${decision.option.label} on !${answer.ask.id}${said}. Mark !${answer.ask.id} done once nothing more is expected.`,
        `card-ask-${task.id}-${String(gate.entry)}-${answer.answerId}`,
      )
      .catch((error: unknown) =>
        this.ports.diagnostics.warn(`could not tell ${formatCardRef(task)}'s ferret: ${errorText(error)}`),
      );
  }

  /** Files come only with a Not good, from this ask's own ferret, and only where this daemon can carry them. */
  private filesRefusal(answer: GateAnswer, decision: Decision): GateRefusal | undefined {
    const files = answer.attachments;
    if (files === undefined) return undefined;
    if (decision.kind !== 'option' || decision.option.outcome !== 'reopen-with-ask') {
      return {
        code: 'invalid',
        message: `only a Not good takes files, and !${answer.ask.id} was answered otherwise`,
      };
    }
    if (files.from !== answer.ask.ferret) {
      return {
        code: 'invalid',
        message: `the files for !${answer.ask.id} must be uploaded to the ferret it is on`,
      };
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
  private async carried(task: Card, answer: GateAnswer): Promise<BoardReopenAttachments | GateRefusal | undefined> {
    const files = answer.attachments;
    if (files === undefined || this.ports.files === undefined) return undefined;
    const to = effectiveAssignee(task);
    try {
      return { from: to, ids: [...(await this.ports.files.carry(files.from, to, files.ids))] };
    } catch (error) {
      return {
        code: 'not-moved',
        message: `${formatCardRef(task)} was not moved: a file could not be carried to its ferret: ${errorText(error)}`,
      };
    }
  }

  /** "Not yet" with words: kept on the card as the owner's, and told to its ferret. The card stays where it is. */
  private async notYet(task: Card, words: string, answer: GateAnswer): Promise<void> {
    const refusal = await this.act(
      task.id,
      { action: 'clarify', text: words, source: `owner (ask !${answer.ask.id})` },
      answer,
    );
    if (refusal !== undefined)
      this.ports.diagnostics.warn(`the owner's words on ${formatCardRef(task)} were not kept: ${refusal.message}`);
    await this.ports.words
      .told(
        task,
        `${formatCardRef(task)}: the owner is not ready to move it on yet: ${words}`,
        `gate-not-yet-${task.id}-${answer.answerId}`,
      )
      .catch((error: unknown) =>
        this.ports.diagnostics.warn(`could not tell ${formatCardRef(task)}'s ferret: ${errorText(error)}`),
      );
  }

  /** One board act as the owner; the board's refusal as a gate refusal. */
  private async act(
    id: CardId,
    request: CardActionRequest,
    answer: GateAnswer,
    expect?: GateExpectation,
  ): Promise<GateRefusal | undefined> {
    try {
      await this.ports.board.act(id, request, answer.caller, expect);
      return undefined;
    } catch (error) {
      return { code: 'not-moved', message: `${formatCardRef({ id })} was not moved: ${errorText(error)}` };
    }
  }
}

/** What the owner's answer means on this gate. */
type Decision =
  | {
      readonly kind: 'option';
      readonly option: CardGateOption;
      readonly note: string | null;
      readonly words?: string;
    }
  | { readonly kind: 'not-yet'; readonly note: string | null; readonly words?: string };

/**
 * Everything an answer says, as the daemon reads it: the choice, the owner's normalized words and the files as sent,
 * as a digest, so two answers are the same only when they say the same.
 */
export const receiptOf = (answer: GateAnswer, decision: Pick<Decision, 'words'>): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        answer.choice ?? null,
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
 * Reads the answer against the gate: a chosen label is its option (or "Not yet"); the owner's own words alone (no
 * choice) are the gate's Not good. Reopen-with-ask needs words, from the note or the answer.
 */
export const decide = (gate: CardGate, answer: GateAnswer): Decision | GateRefusal => {
  const note = answer.text?.trim() ?? '';
  const words = (text: string): { readonly words?: string } => (text === '' ? {} : { words: text });
  if (answer.choice === undefined) {
    const option = gateReopenOption(gate);
    if (option === undefined || note === '') {
      return {
        code: 'invalid',
        message: `!${answer.ask.id} is answered with one of its options: ${gate.options.map(each => each.label).join(', ')}`,
      };
    }
    return { kind: 'option', option, note: null, ...words(note) };
  }
  const choice = gateChoice(gate, answer.choice);
  if (choice.kind === 'unknown') {
    return { code: 'invalid', message: `!${answer.ask.id} has no option ${answer.choice}` };
  }
  if (choice.kind === 'not-yet') return { kind: 'not-yet', note: note === '' ? null : note, ...words(note) };
  if (choice.option.outcome === 'reopen-with-ask' && note === '') {
    return {
      code: 'invalid',
      message: `say what is not good: ${choice.option.label} needs your words, and the ferret gets them`,
    };
  }
  return { kind: 'option', option: choice.option, note: note === '' ? null : note, ...words(note) };
};

export { receiptOf as gateAnswerReceipt };
