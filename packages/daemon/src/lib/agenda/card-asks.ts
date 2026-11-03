/**
 * CARD ASKS ON AN AGENDA — the pure half (docs/agenda.md § Card asks). A card never asks the owner itself: the gate
 * engine (`board/gate-items.ts`) puts its ask on the agenda that carries it, and this file decides what that does to
 * the agenda item:
 *
 * - **Attach.** A NEW ask wakes the agenda into Needs you, fresh — even out of a snooze or a discussion, because it
 *   is a blocker of its card — and moves its stage to `test` or `plan`. Restating an open one (a renamed lane, edited
 *   steps) changes only the ask. An ask the owner already answered is never asked again.
 * - **Withdraw.** The card left that gate unanswered (moved on by the owner on the Board, dropped): the open ask goes.
 *   An agenda left with nothing to answer does not sit in Needs you. A ferret's own thread goes back to the turn the
 *   ask woke it out of (`woke`): the owner's, with the question it had, or the park, rest or wait it was in — unless
 *   something moved it since, which stays. The card agenda the daemon opened (`card-agenda:`) goes back to resting
 *   on its ferret when it holds answered asks or talk, and closes when it holds neither.
 * - **Answer.** The owner's answer is kept on the ask, with its receipt; the agenda RESTS, waiting on its ferret,
 *   unless another card ask on it is still open. It is never closed by the answer: the ferret marks it Done.
 * - **Not yet.** The ask stays open, marked, and the agenda rests the same way.
 *
 * `gateAttached` mirrors the first open ask's gate on every write, for an app that predates card asks. Pure and total.
 */
import {
  type AgendaCardAsk,
  type AgendaCardAskAnswer,
  type AgendaCardAskWoke,
  type AgendaItem,
  cardAskReference,
  cardAskStage,
  formatTaskRef,
  isOpenCardAsk,
  MAX_AGENDA_CARD_ASKS,
  MAX_AGENDA_REPLY_LENGTH,
  mirroredCardAsk,
  openCardAsks,
  parseCardAgendaReference,
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
  | { readonly kind: 'changed'; readonly item: AgendaItem; readonly change: 'refreshed' | 'woke' | 'answered' }
  /** The last open ask was withdrawn from a card agenda with nothing else in it: it closes, as the daemon's. */
  | { readonly kind: 'closed'; readonly item: AgendaItem; readonly note: string };

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

/**
 * The item carrying exactly these asks, `gateAttached` mirroring the first open one; both absent when none is left.
 * Given the time of the write (`at`), a mirror that comes to show a DIFFERENT ask than it did is stamped
 * (`gateAttachedChangedAt`); one that shows the same ask keeps its stamp, and one that shows nothing drops it.
 */
export const withCardAsks = (item: AgendaItem, asks: readonly AgendaCardAsk[], at?: string): AgendaItem => {
  const { cardAsks: _asks, gateAttached: before, gateAttachedChangedAt: stamped, ...rest } = item;
  const kept = bounded(asks);
  const mirror = mirroredCardAsk({ cardAsks: kept });
  const replaced =
    before !== undefined && mirror !== undefined && cardAskReference({ gate: before }) !== cardAskReference(mirror);
  const changedAt = mirror === undefined ? undefined : replaced ? at : before === undefined ? undefined : stamped;
  return {
    ...rest,
    ...(kept.length === 0 ? {} : { cardAsks: kept }),
    ...(mirror === undefined ? {} : { gateAttached: mirror.gate }),
    ...(changedAt === undefined ? {} : { gateAttachedChangedAt: changedAt }),
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

/** The turn an item is in now, as a new ask would end it (`AgendaCardAsk.woke`). */
const turnOf = (item: AgendaItem): AgendaCardAskWoke => ({
  waitingSince: item.waitingSince,
  ...(item.parked === undefined ? {} : { parked: item.parked }),
  ...(item.resting === undefined ? {} : { resting: item.resting }),
  ...(item.waitingOn === undefined ? {} : { waitingOn: item.waitingOn }),
  ...(item.askedAt === undefined ? {} : { askedAt: item.askedAt }),
  ...(item.waitingFor === undefined ? {} : { waitingFor: item.waitingFor }),
});

/** The item back in the turn an ask woke it out of: the owner's with the question it had, or the park, rest or wait it was in. */
const backTo = (item: AgendaItem, turn: AgendaCardAskWoke): AgendaItem => ({
  ...awake(item, turn.waitingSince),
  ...turn,
});

/** Whether nothing has happened to the item's turn since an ask woke it at `at`: still the owner's, still from that ask. */
const stillWoken = (item: AgendaItem, at: string): boolean =>
  item.parked === undefined && item.waitingOn === undefined && item.waitingSince === at;

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

/** Whether the daemon opened this agenda for its card (`card-agenda:`): it holds the card's asks and nothing of the ferret's. */
const isCardAgenda = (item: Pick<AgendaItem, 'raisedBy' | 'sourceRef'>): boolean =>
  item.raisedBy === 'daemon' && parseCardAgendaReference(item.sourceRef) !== undefined;

/** Whether the owner or a ferret has said anything on an agenda: the daemon's own lines are not talk. */
const hasTalk = (item: AgendaItem): boolean =>
  (item.history ?? []).some(entry => entry.kind !== 'updated' && entry.kind !== 'gate-answered') ||
  item.ownerAnswer !== undefined;

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
        at,
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
    // A ferret's thread remembers the turn this ask ends; a second ask joining a first the owner has yet to look at
    // keeps the first's, so the thread goes back to the turn it was in before either.
    const first = openCardAsks(item).find(ask => ask.notYet === undefined);
    const woke = isCardAgenda(item) ? undefined : first === undefined ? turnOf(item) : first.woke;
    const added: AgendaCardAsk = {
      gate: operation.ask.gate,
      at,
      ...(woke === undefined ? {} : { woke }),
      ...(operation.ask.howToTest === undefined ? {} : { howToTest: operation.ask.howToTest }),
    };
    const woken = effects.history(
      effects.stage(awake(item, at), cardAskStage(added.gate)),
      'updated',
      askedLine(added),
    );
    return { kind: 'changed', item: withCardAsks(woken, [...asks, added], at), change: 'woke' };
  }
  const target = asks.find(ask => cardAskReference(ask) === operation.reference);
  if (operation.kind === 'withdraw') {
    if (target === undefined || !isOpenCardAsk(target)) return { kind: 'unchanged' };
    const left = withCardAsks(
      item,
      asks.filter(ask => ask !== target),
      at,
    );
    if (openCardAsks(left).length > 0) {
      // The newest ask goes: the thread has waited on the owner since the one before, not since the one that went.
      const newest = Math.max(...openCardAsks(left).map(ask => Date.parse(ask.at)));
      const settled = stillWoken(left, target.at) ? { ...left, waitingSince: new Date(newest).toISOString() } : left;
      return { kind: 'changed', item: settled, change: 'refreshed' };
    }
    const note = `${formatTaskRef({ id: target.gate.cardId })} moved on, so nothing is left to answer`;
    const told = effects.history(left, 'updated', note);
    if (target.woke !== undefined && !isCardAgenda(left)) {
      // A ferret's thread goes back to the turn the ask woke it out of; one that has moved on since stays as it is.
      return {
        kind: 'changed',
        item: stillWoken(left, target.at) ? backTo(told, target.woke) : told,
        change: 'refreshed',
      };
    }
    if ((left.cardAsks ?? []).length > 0 || (isCardAgenda(left) && hasTalk(left))) {
      return { kind: 'changed', item: restedOnAnswer(told, at), change: 'refreshed' };
    }
    return isCardAgenda(left)
      ? { kind: 'closed', item: told, note }
      : { kind: 'changed', item: left, change: 'refreshed' };
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
    at,
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
