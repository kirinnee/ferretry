/**
 * CARD ASKS ON AN AGENDA — the pure half (docs/agenda.md § Card asks). A card never asks the owner itself: the gate
 * engine (`board/gate-items.ts`) puts its ask on the agenda that carries it, and this file decides what that does to
 * the agenda item:
 *
 * - **Attach.** A NEW ask wakes the agenda into Needs you, fresh — even out of a snooze or a discussion, because it
 *   is a blocker of its card — and moves its stage to `test` or `plan`. Restating an open one (a renamed lane, edited
 *   steps) changes only the ask. An ask the owner already answered is never asked again.
 * - **Withdraw.** The card left that gate unanswered (moved on by the owner on the Board, dropped): the open ask goes.
 * - **Answer.** The owner's answer is kept on the ask, with its receipt; the agenda RESTS, waiting on its ferret,
 *   unless another card ask on it is still open. It is never closed by the answer: the ferret marks it Done.
 * - **Not yet.** The ask stays open, marked, and the agenda rests the same way.
 *
 * `gateAttached` mirrors the first open ask's gate on every write, for an app that predates card asks. Pure and total.
 */
import {
  type AgendaCardAsk,
  type AgendaCardAskAnswer,
  type AgendaItem,
  cardAskReference,
  cardAskStage,
  formatTaskRef,
  isOpenCardAsk,
  MAX_AGENDA_CARD_ASKS,
  MAX_AGENDA_REPLY_LENGTH,
  mirroredCardAsk,
  openCardAsks,
} from '@ferretry/protocol';

/** What the gate engine does to one agenda's card asks. */
export type CardAskOperation =
  /** The card waits at this gate: the ask is put on the agenda, or restated as the card now stands. */
  | { readonly kind: 'attach'; readonly ask: Pick<AgendaCardAsk, 'gate' | 'howToTest'> }
  /** The card left this gate without the owner's answer: the open ask goes. */
  | { readonly kind: 'withdraw'; readonly reference: string }
  /** The owner answered and the card moved as they said: the answer is kept, and the agenda rests. */
  | { readonly kind: 'answered'; readonly reference: string; readonly answer: AgendaCardAskAnswer }
  /** The owner said Not yet: the ask stays open, and the agenda rests. */
  | { readonly kind: 'not-yet'; readonly reference: string; readonly note?: string };

/** What an operation came to: the item to write and how it changed, or why nothing was written. */
export type CardAskOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly code: 'invalid' | 'full'; readonly message: string }
  | { readonly kind: 'changed'; readonly item: AgendaItem; readonly change: 'refreshed' | 'woke' | 'answered' };

/**
 * The asks an agenda keeps: every open one, then the newest answered ones up to {@link MAX_AGENDA_CARD_ASKS}, in
 * the order they were put on it.
 */
const bounded = (asks: readonly AgendaCardAsk[]): AgendaCardAsk[] => {
  const room = MAX_AGENDA_CARD_ASKS - asks.filter(isOpenCardAsk).length;
  const answered = asks.filter(ask => !isOpenCardAsk(ask));
  const kept = new Set(answered.slice(Math.max(0, answered.length - Math.max(0, room))));
  return asks.filter(ask => isOpenCardAsk(ask) || kept.has(ask));
};

/** The item carrying exactly these asks, `gateAttached` mirroring the first open one; both absent when none is left. */
export const withCardAsks = (item: AgendaItem, asks: readonly AgendaCardAsk[]): AgendaItem => {
  const { cardAsks: _asks, gateAttached: _mirror, ...rest } = item;
  const kept = bounded(asks);
  const mirror = mirroredCardAsk({ cardAsks: kept });
  return {
    ...rest,
    ...(kept.length === 0 ? {} : { cardAsks: kept }),
    ...(mirror === undefined ? {} : { gateAttached: mirror.gate }),
  };
};

/** What an attached ask says it is about, as the activity line records it: "&F12 is at Released: Done or Not good". */
const askedLine = (ask: Pick<AgendaCardAsk, 'gate'>): string =>
  `${formatTaskRef({ id: ask.gate.cardId })} is at ${ask.gate.laneName}: ${ask.gate.options.map(option => option.label).join(' or ')}`;

/** The item woken into Needs you, fresh: every park, rest and wait on the ferret ends. */
const awake = (item: AgendaItem, at: string): AgendaItem => {
  const {
    parked: _parked,
    resting: _resting,
    waitingOn: _waitingOn,
    askedAt: _askedAt,
    waitingFor: _waitingFor,
    ...rest
  } = item;
  return { ...rest, waitingSince: at };
};

/** The item resting on the owner's answer, waiting on its ferret, as every other answer rests one. */
const restedOnAnswer = (item: AgendaItem, at: string): AgendaItem => {
  if (openCardAsks(item).some(ask => ask.notYet === undefined)) return item;
  const {
    waitingOn: _waitingOn,
    askedAt: _askedAt,
    waitingFor: _waitingFor,
    undelivered: _undelivered,
    parked: _parked,
    resting: _resting,
    ...open
  } = item;
  return { ...open, parked: { reason: 'replied', at }, resting: { sub: 'waiting-on-ferret', at } };
};

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * One operation on one open item's card asks. `stage` moves the item to the stage an ask puts it in, as the state
 * machine records a stage change; `history` adds one activity line.
 */
export const applyCardAsk = (
  item: AgendaItem,
  operation: CardAskOperation,
  at: string,
  effects: {
    readonly stage: (item: AgendaItem, stage: 'test' | 'plan') => AgendaItem;
    readonly history: (item: AgendaItem, kind: 'updated' | 'gate-answered', note: string) => AgendaItem;
  },
): CardAskOutcome => {
  const asks = item.cardAsks ?? [];
  if (operation.kind === 'attach') {
    const reference = cardAskReference(operation.ask);
    const existing = asks.find(ask => cardAskReference(ask) === reference);
    if (existing !== undefined) {
      if (!isOpenCardAsk(existing)) return { kind: 'unchanged' };
      const { howToTest: _steps, ...kept } = existing;
      const restated: AgendaCardAsk = {
        ...kept,
        gate: operation.ask.gate,
        ...(operation.ask.howToTest === undefined ? {} : { howToTest: operation.ask.howToTest }),
      };
      const next = withCardAsks(
        item,
        asks.map(ask => (ask === existing ? restated : ask)),
      );
      return sameJson(next, item) ? { kind: 'unchanged' } : { kind: 'changed', item: next, change: 'refreshed' };
    }
    if (asks.filter(isOpenCardAsk).length >= MAX_AGENDA_CARD_ASKS) {
      return {
        kind: 'refused',
        code: 'full',
        message: `${item.id} already carries ${String(MAX_AGENDA_CARD_ASKS)} open card asks`,
      };
    }
    const added: AgendaCardAsk = {
      gate: operation.ask.gate,
      at,
      ...(operation.ask.howToTest === undefined ? {} : { howToTest: operation.ask.howToTest }),
    };
    const woken = effects.history(
      effects.stage(awake(item, at), cardAskStage(added.gate)),
      'updated',
      askedLine(added),
    );
    return { kind: 'changed', item: withCardAsks(woken, [...asks, added]), change: 'woke' };
  }
  const target = asks.find(ask => cardAskReference(ask) === operation.reference);
  if (operation.kind === 'withdraw') {
    if (target === undefined || !isOpenCardAsk(target)) return { kind: 'unchanged' };
    return {
      kind: 'changed',
      item: withCardAsks(
        item,
        asks.filter(ask => ask !== target),
      ),
      change: 'refreshed',
    };
  }
  if (target === undefined) {
    return { kind: 'refused', code: 'invalid', message: `${item.id} carries no card ask ${operation.reference}` };
  }
  if (!isOpenCardAsk(target)) {
    return operation.kind === 'answered' && target.answer?.receipt === operation.answer.receipt
      ? { kind: 'unchanged' }
      : { kind: 'refused', code: 'invalid', message: `${item.id}'s ask ${operation.reference} is already answered` };
  }
  const changed: AgendaCardAsk =
    operation.kind === 'answered'
      ? { ...target, answer: operation.answer }
      : {
          ...target,
          notYet: {
            at,
            ...(operation.note === undefined || operation.note.trim() === ''
              ? {}
              : { note: operation.note.trim().slice(0, MAX_AGENDA_REPLY_LENGTH) }),
          },
        };
  const answered = withCardAsks(
    effects.history(item, 'gate-answered', operation.reference),
    asks.map(ask => (ask === target ? changed : ask)),
  );
  return { kind: 'changed', item: restedOnAnswer(answered, at), change: 'answered' };
};

/** Why a ferret may not close this agenda now, or `undefined` when it may: an open card ask is the owner's to answer. */
export const closeRefusal = (item: AgendaItem): string | undefined => {
  const open = openCardAsks(item);
  if (open.length === 0) return undefined;
  const cards = [...new Set(open.map(ask => formatTaskRef({ id: ask.gate.cardId })))].join(', ');
  return `${item.id} carries the ask of ${cards}, which only the owner answers: it stays open until they do (add what you have with \`agenda edit ${item.id}\`)`;
};

/** Why a ferret may not rest this agenda now, or `undefined`: an ask the owner has not answered at all keeps it theirs. */
export const restRefusal = (item: AgendaItem): string | undefined => {
  const waiting = openCardAsks(item).filter(ask => ask.notYet === undefined);
  if (waiting.length === 0) return undefined;
  const cards = [...new Set(waiting.map(ask => formatTaskRef({ id: ask.gate.cardId })))].join(', ');
  return `${item.id} carries the ask of ${cards}, which waits on the owner: it stays in Needs you until they answer`;
};
