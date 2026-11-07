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
 *   on its ferret when it holds answered asks or talk, and closes when it holds neither; one sealed and written on
 *   since stays where it is.
 * - **Answer.** The owner's answer is kept on the ask, with its receipt; the agenda RESTS, waiting on its ferret,
 *   unless another card ask on it is still open, or the item still asks something of its OWN the owner has not
 *   answered (a choice, permission, task or review, or a question in its own words: `itemAsksOwnQuestion`, the rule the
 *   app reads too): that keeps it in Needs you until they answer it. It is never closed by the answer: the ferret marks
 *   it Done.
 * - **Not yet.** The ask stays open, marked, and the agenda rests the same way.
 *
 * Pure and total.
 */
import { createHash } from 'node:crypto';
import {
  type AgendaCardAsk,
  type AgendaCardAskAnswer,
  type AgendaCardAskWoke,
  type AgendaItem,
  MAX_AGENDA_CARD_ASKS,
  MAX_AGENDA_REPLY_LENGTH,
} from '../protocol/agenda.ts';
import { agendaState } from '../protocol/agenda-state.ts';
import {
  canCarryCardAsk,
  cardAskReference,
  cardAskStage,
  awaitsOwnAnswer as protocolAwaitsOwnAnswer,
  hasOpenCardAsk,
  itemAsksOwnQuestion,
  isOpenCardAsk,
  ownAskDigest,
  openCardAsks,
  parseCardAgendaReference,
  repliedToOwnAsk,
} from '../protocol/agenda-card-asks.ts';
import { canonicalJson } from '@ferretry/std';
import { formatTaskRef } from '../protocol/board-refs.ts';

/** What the gate engine does to one agenda's card asks. */
export type CardAskOperation =
  /** The card waits at this gate: the ask is put on the agenda, or restated as the card now stands. */
  | { readonly kind: 'attach'; readonly ask: Pick<AgendaCardAsk, 'gate' | 'howToTest'> }
  /** The card left this gate without the owner's answer: the open ask goes. */
  | { readonly kind: 'withdraw'; readonly reference: string }
  /** The owner answered and the card moved as they said: the answer is kept, and the agenda rests. */
  | { readonly kind: 'answered'; readonly reference: string; readonly answer: AgendaCardAskAnswer }
  /** The owner said Not yet: the ask stays open, and the agenda rests. */
  | { readonly kind: 'not-yet'; readonly reference: string; readonly note?: string }
  /**
   * ONE plain line of the daemon's on the agenda's activity, nothing else: no ask, no button, and the item's turn, stage
   * and place in Needs you stay exactly as they were. The same line twice in a row is written once.
   */
  | { readonly kind: 'line'; readonly line: string };

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

/** The item carrying exactly these asks (at most {@link MAX_AGENDA_CARD_ASKS}); absent when none is left. */
export const withCardAsks = (item: AgendaItem, asks: readonly AgendaCardAsk[]): AgendaItem => {
  const { cardAsks: _asks, ...rest } = item;
  const kept = bounded(asks);
  return { ...rest, ...(kept.length === 0 ? {} : { cardAsks: kept }) };
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

/**
 * The digest of everything on the thread but what the card-ask writer owns (the asks, their mirror and the seal
 * itself) and the Warden's nudge clock (a nudge writes it on a rest nobody has touched): its words (the conversation by
 * its count of them), turn, park, stage and edits. `undefined` when it has no canonical spelling.
 */
const fingerprint = (item: AgendaItem): string | undefined => {
  const {
    cardAsks: _asks,
    cardAsksSeal: _seal,
    resting,
    conversation,
    conversationCount,
    conversationLastAt: _lastAt,
    ...rest
  } = item;
  const { nudgeSend: _send, nudgedAt: _nudgedAt, nudges: _nudges, ...stable } = resting ?? {};
  // The conversation is read by how many words it holds (docs/agenda.md § The conversation): a write sees the whole
  // thread, the stored item a bounded tail and its count, and words are only ever added.
  const said = Math.max(conversationCount ?? 0, conversation?.length ?? 0);
  const spelled = canonicalJson({ ...(resting === undefined ? rest : { ...rest, resting: stable }), said });
  return spelled.ok ? createHash('sha256').update(spelled.text, 'utf8').digest('hex').slice(0, 32) : undefined;
};

/** A seal's length: the digest is sliced to it, and the fit leaves room for it before the real one is known. */
const PLACEHOLDER_SEAL = '0'.repeat(32);

/** The item with the seal of the thread as it now stands. */
export const sealCardAsks = (item: AgendaItem): AgendaItem => {
  const digest = fingerprint(item);
  const { cardAsksSeal: _seal, ...rest } = item;
  return digest === undefined ? rest : { ...rest, cardAsksSeal: digest };
};

/** Whether the thread is exactly as the card-ask writer left it: nobody else has written anything on it since. */
const untouched = (item: AgendaItem): boolean =>
  item.cardAsksSeal !== undefined && item.cardAsksSeal === fingerprint(item);

/** The digest of the item's own ask: one spelling for both ends (`agenda-card-asks`). */
export { ownAskDigest };

/** Whether an owner's answer to a card ask was recorded on the item after `at`. */
const answeredSince = (item: AgendaItem, at: string): boolean =>
  (item.history ?? []).some(entry => entry.kind === 'gate-answered' && entry.at > at);

/**
 * Whether the item still has an ask of its OWN for the owner, and no answer of theirs on it: a choice, yes/no,
 * permission, task or review, or a question the item asks in its own words beside its card asks (`itemAsksOwnQuestion`
 * — questions, fields or steps, or an ask line that is neither the daemon's generated card agenda ask nor one that only
 * repeats a card ask). The ONE rule the app reads to keep that line on screen, so an item the app shows asking
 * something stays in Needs you after its card ask's answer, and only the owner's answer (or reply) to it rests the item.
 * A reply in words counts for the open question it answered, before or after the card ask came, for as long as that
 * question stands unchanged (`ownAskRepliedTo`); a choice, permission, task or review takes its answer.
 * A card agenda with its generated ask, and a reply thread whose line only repeats its card ask, asked nothing else.
 * `held` is every card ask the item held when the operation began: one just withdrawn or moved away still wrote (or was
 * repeated by) the line, so the line is read against it too.
 */
const awaitsOwnAnswer = (item: AgendaItem, held: readonly AgendaCardAsk[]): boolean =>
  protocolAwaitsOwnAnswer(
    { ...item, cardAsks: held },
    held.map(ask => ({ gate: ask.gate, howToTest: ask.howToTest ?? null })),
  );

/**
 * Whether an agenda asks the owner NOTHING BUT its card asks: it carries one still open and nothing of its own to
 * answer (`awaitsOwnAnswer`, the shared own-question rule and the reply digest). The ask made its push when it was put,
 * which is then the item's whole signal: a stop never names it again and it has no deadline of its own. The card agenda
 * the daemon opened is that while its subject is the one it wrote; a ferret's thread is, until its ferret asks (or
 * rewords) a question of its own, which the owner has yet to answer. Total.
 */
export const asksOnlyCardAsks = (item: AgendaItem): boolean =>
  hasOpenCardAsk(item) && !awaitsOwnAnswer(item, item.cardAsks ?? []);

/**
 * The item resting on the owner's answer, waiting on its ferret, as every other answer rests one — unless another
 * card ask is still waiting on the owner, or the item's own ask is still unanswered: then it stays (or goes back to)
 * the owner's turn, in Needs you, and only their answer to that ask rests it.
 */
const restedOnAnswer = (
  item: AgendaItem,
  at: string,
  held: readonly AgendaCardAsk[] = item.cardAsks ?? [],
): AgendaItem => {
  if (openCardAsks(item).some(ask => ask.notYet === undefined)) return item;
  if (awaitsOwnAnswer(item, held)) {
    const {
      waitingOn: _waitingOn,
      askedAt: _askedAt,
      waitingFor: _waitingFor,
      parked: _parked,
      resting: _resting,
      ...owners
    } = item;
    return owners;
  }
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

/**
 * Whether the owner has answered the item's OWN question (a choice, or words in reply) while it stood unchanged. Their
 * answer kept the item in Needs you only because a card ask waited behind it (`ownFirst`); with that ask gone nothing is left
 * for them, so the item rests on the answer they already gave.
 */
const ownQuestionAnswered = (item: AgendaItem): boolean => item.ownerAnswer !== undefined || repliedToOwnAsk(item);

/**
 * Whether the owner or a ferret has said anything on a card's own agenda. A sealed one is read by its seal; one from
 * before the seal by its activity lines, where the daemon's own (`updated`, `gate-answered`) are not talk.
 */
const talkedOn = (item: AgendaItem): boolean =>
  item.cardAsksSeal === undefined
    ? (item.history ?? []).some(entry => entry.kind !== 'updated' && entry.kind !== 'gate-answered') ||
      item.ownerAnswer !== undefined
    : !untouched(item);

const spelled = (value: unknown): string => {
  const canonical = canonicalJson(value);
  return canonical.ok ? canonical.text : JSON.stringify(value);
};

/** Whether two values are the same content, however their keys were spread. */
const sameJson = (left: unknown, right: unknown): boolean => spelled(left) === spelled(right);

/** What the state machine lends the pure half: the stage move an ask makes, the activity line, and the form an item is stored in. */
export interface CardAskEffects {
  readonly stage: (item: AgendaItem, stage: 'test' | 'plan') => AgendaItem;
  readonly history: (item: AgendaItem, kind: 'updated' | 'gate-answered', note: string) => AgendaItem;
  readonly tidy: (item: AgendaItem) => AgendaItem;
}

const operate = (
  item: AgendaItem,
  operation: CardAskOperation,
  at: string,
  effects: CardAskEffects,
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
        message: `${item.id} already carries ${String(MAX_AGENDA_CARD_ASKS)} open asks about cards`,
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
    return { kind: 'changed', item: withCardAsks(woken, [...asks, added]), change: 'woke' };
  }
  if (operation.kind === 'line') {
    const last = item.history?.at(-1);
    return last?.kind === 'updated' && last.note === operation.line
      ? { kind: 'unchanged' }
      : { kind: 'changed', item: effects.history(item, 'updated', operation.line), change: 'refreshed' };
  }
  const target = asks.find(ask => cardAskReference(ask) === operation.reference);
  if (operation.kind === 'withdraw') {
    if (target === undefined || !isOpenCardAsk(target)) return { kind: 'unchanged' };
    const left = withCardAsks(
      item,
      asks.filter(ask => ask !== target),
    );
    // Only a thread nobody has written on since the daemon left it is moved.
    const asLeft = untouched(item);
    const waiting = openCardAsks(left).filter(ask => ask.notYet === undefined);
    if (waiting.length > 0) {
      // The newest ask goes: the thread has waited on the owner since the one before, not since the one that went.
      const newest = Math.max(...waiting.map(ask => Date.parse(ask.at)));
      const settled = asLeft ? { ...left, waitingSince: new Date(newest).toISOString() } : left;
      return { kind: 'changed', item: settled, change: 'refreshed' };
    }
    const note = `${formatTaskRef({ id: target.gate.cardId })} moved on, so nothing is left to answer`;
    const told = effects.history(left, 'updated', note);
    if (target.woke !== undefined && !isCardAgenda(left)) {
      // A ferret's thread goes back to the turn the ask woke it out of, or rests when the owner's answer to another ask
      // is the last thing on it; one anybody has written on since stays as it is, in Needs you.
      const settled = !asLeft
        ? ownQuestionAnswered(item) && agendaState(told).state === 'needs-you'
          ? restedOnAnswer(told, at, item.cardAsks)
          : told
        : answeredSince(left, target.at)
          ? restedOnAnswer(told, at, item.cardAsks)
          : backTo(told, target.woke);
      return { kind: 'changed', item: settled, change: 'refreshed' };
    }
    // An ask from before `woke` was kept has no turn to go back to; on a ferret's thread it rests the thread only when
    // the thread is still as the daemon left it.
    // A sealed card agenda somebody wrote on since stays where it is, as a ferret's thread does: the owner's reply
    // already rested it, and a ferret's answer is in front of the owner.
    if (isCardAgenda(left) && item.cardAsksSeal !== undefined && !asLeft) {
      return {
        kind: 'changed',
        item:
          ownQuestionAnswered(item) && agendaState(told).state === 'needs-you'
            ? restedOnAnswer(told, at, item.cardAsks)
            : told,
        change: 'refreshed',
      };
    }
    const holdsAnswers = (left.cardAsks ?? []).length > 0 && (isCardAgenda(left) || asLeft);
    if (holdsAnswers || (isCardAgenda(left) && talkedOn(item))) {
      return { kind: 'changed', item: restedOnAnswer(told, at, item.cardAsks), change: 'refreshed' };
    }
    return isCardAgenda(left)
      ? { kind: 'closed', item: told, note }
      : { kind: 'changed', item: left, change: 'refreshed' };
  }
  if (target === undefined) {
    return { kind: 'refused', code: 'invalid', message: `${item.id} has no open ask ${operation.reference}` };
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

/** How far the owner got with an ask: answered, then set aside with Not yet, then not looked at. */
const progressOf = (ask: AgendaCardAsk): number => (ask.answer !== undefined ? 2 : ask.notYet !== undefined ? 1 : 0);

/** One ask per card and entry of that card into its lane: the gate it asks about, wherever it rides. */
const askKey = (ask: Pick<AgendaCardAsk, 'gate'>): string => `${ask.gate.cardId}:${String(ask.gate.entry)}`;

/** What moving card asks between two items (a merge, a split) came to. */
export type CardAsksMove =
  | { readonly kind: 'refused'; readonly code: 'invalid' | 'full'; readonly message: string }
  | { readonly kind: 'moved'; readonly into: AgendaItem };

/** The item stripped of every card ask: what is left of one whose asks went to another item. */
export const withoutCardAsks = (item: AgendaItem): AgendaItem => {
  const { cardAsks: _asks, cardAsksSeal: _seal, ...rest } = item;
  return rest;
};

/**
 * The asks `incoming` brings to `item`, which keeps its own (docs/agenda.md § Merge and split): ONE per card and entry
 * — of two for the same, the one the owner got further with (an answer, then Not yet), else `item`'s — in the order
 * they were put. Nothing is trimmed to fit: more asks than one agenda carries (16 in all, answered or not, so no answer
 * or receipt is lost) are refused, and so is an item that cannot carry a card's ask, since the gate engine would not
 * find it there and would ask again.
 *
 * An ask still waiting on the owner that comes in does to `item` what putting it there does: an item not on the owner's
 * turn wakes into Needs you, at the stage the ask puts it in, and the ask remembers the turn it ended (`woke`), or the
 * one the asks already waiting on it ended. The seal is left as it was: whoever moved the asks wrote on the thread, so
 * it never again reads as the way the card-ask writer left it.
 */
export const joinCardAsks = (
  item: AgendaItem,
  incoming: readonly AgendaCardAsk[],
  stage: CardAskEffects['stage'],
): CardAsksMove => {
  if (incoming.length === 0) return { kind: 'moved', into: item };
  if (!canCarryCardAsk(item)) {
    return {
      kind: 'refused',
      code: 'invalid',
      message: `${item.id} cannot carry a card's ask (${[...new Set(incoming.map(ask => formatTaskRef({ id: ask.gate.cardId })))].join(', ')})`,
    };
  }
  const own = item.cardAsks ?? [];
  const chosen = new Map<string, AgendaCardAsk>();
  for (const ask of [...own, ...incoming]) {
    const held = chosen.get(askKey(ask));
    if (held === undefined || progressOf(ask) > progressOf(held)) chosen.set(askKey(ask), ask);
  }
  const kept = [...chosen.values()].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  if (kept.length > MAX_AGENDA_CARD_ASKS) {
    return {
      kind: 'refused',
      code: 'full',
      message: `${item.id} would carry more than ${String(MAX_AGENDA_CARD_ASKS)} asks about cards, answered or not: nothing is dropped to fit`,
    };
  }
  const waitingOn = (asks: readonly AgendaCardAsk[]): AgendaCardAsk[] =>
    asks.filter(ask => isOpenCardAsk(ask) && ask.notYet === undefined);
  const arriving = new Set(waitingOn(kept).filter(ask => !own.includes(ask)));
  if (arriving.size === 0) return { kind: 'moved', into: withCardAsks(item, kept) };
  const first = waitingOn(own)[0];
  const woke = isCardAgenda(item) ? undefined : first === undefined ? turnOf(item) : first.woke;
  const retold = kept.map(ask => {
    if (!arriving.has(ask)) return ask;
    const { woke: _theirs, ...rest } = ask;
    return woke === undefined ? rest : { ...rest, woke };
  });
  if (first !== undefined) return { kind: 'moved', into: withCardAsks(item, retold) };
  const newest = new Date(Math.max(...[...arriving].map(ask => Date.parse(ask.at)))).toISOString();
  const woken = agendaState(item).state === 'needs-you' ? item : awake(item, newest);
  const staged = stage(woken, cardAskStage(([...arriving][0] as AgendaCardAsk).gate));
  return { kind: 'moved', into: withCardAsks(staged, retold) };
};

/**
 * `item` once the asks of the cards `moves` names went to another item (a split): it keeps the rest. An item that asked
 * the owner NOTHING but those asks (`awaitsOwnAnswer`: no question of its own, or one the owner answered) does not sit
 * in Needs you with nothing to answer: a ferret's thread nobody has written on since goes back to the turn the first of
 * them ended, and any other rests on its ferret. An item with an outstanding question of its own, or a thread written
 * on since, stays on the owner's turn.
 */
export const leaveCardAsks = (
  item: AgendaItem,
  moves: (ask: AgendaCardAsk) => boolean,
  at: string,
): { readonly left: AgendaItem; readonly moved: readonly AgendaCardAsk[] } => {
  const moved = (item.cardAsks ?? []).filter(moves);
  if (moved.length === 0) return { left: item, moved };
  const left = withCardAsks(
    item,
    (item.cardAsks ?? []).filter(ask => !moves(ask)),
  );
  const stillWaiting = openCardAsks(left).some(ask => ask.notYet === undefined);
  // An item that asks something of its own (a question a ferret added or reworded beside the ask) stays on the owner's
  // turn: only their answer to it rests it. Nor is a thread somebody has written on since the ask was attached moved.
  if (
    stillWaiting ||
    agendaState(item).state !== 'needs-you' ||
    awaitsOwnAnswer(item, item.cardAsks ?? []) ||
    (!isCardAgenda(item) && !untouched(item))
  ) {
    return { left, moved };
  }
  const turn = moved.find(ask => isOpenCardAsk(ask) && ask.notYet === undefined)?.woke;
  return {
    left: turn === undefined || isCardAgenda(item) ? restedOnAnswer(left, at, item.cardAsks) : backTo(left, turn),
    moved,
  };
};

/**
 * One operation on one open item's card asks. `stage` moves the item to the stage an ask puts it in, as the state
 * machine records a stage change; `history` adds one activity line; `tidy` is the form the item is stored in.
 *
 * The thread is sealed with every change the writer makes to it, as long as it matched its seal before the write, or
 * the write is the first ask on a thread with none open (a new turn of its own): a thread somebody else wrote on keeps
 * the seal it had, which no longer matches it, so it never again reads as the way the daemon left it — no restate,
 * second ask or answer renews it. `tidy` is the stored form: the seal is of the thread as it will be read back.
 */
export const applyCardAsk = (
  item: AgendaItem,
  operation: CardAskOperation,
  at: string,
  effects: CardAskEffects,
): CardAskOutcome => {
  const outcome = operate(item, operation, at, effects);
  if (outcome.kind !== 'changed') return outcome;
  const begins = outcome.change === 'woke' && !isCardAgenda(item) && openCardAsks(item).length === 0;
  // The seal is part of the stored thread, so `tidy` fits it with a seal of the same length in place.
  return untouched(item) || begins
    ? { ...outcome, item: sealCardAsks(effects.tidy({ ...outcome.item, cardAsksSeal: PLACEHOLDER_SEAL })) }
    : outcome;
};

/** Whether a card ask is waiting for the owner now: open, and not set aside with Not yet. */
export const cardAskWaits = (item: AgendaItem): boolean => openCardAsks(item).some(ask => ask.notYet === undefined);

/**
 * Whether an owner's reply on this item leaves it the owner's turn: it carries a card ask still waiting for the owner and
 * asks nothing of its own (`itemAsksOwnQuestion`, the rule `awaitsOwnAnswer` reads). Words typed about such an item — "works
 * now" under a try-it — are logged and delivered to the ferret, but they are not the card ask's answer, so the item must
 * not rest: the promised Good stays in Needs you. A thread that asks its own question is answered by the reply and rests.
 */
export const replyKeepsCardAskOpen = (item: AgendaItem): boolean => {
  const open = openCardAsks(item);
  if (open.length === 0) return false;
  if (item.ask !== undefined && item.ask.kind !== 'open-question') return false;
  return !itemAsksOwnQuestion(
    item,
    (item.cardAsks ?? []).map(ask => ({ gate: ask.gate, howToTest: ask.howToTest ?? null })),
  );
};
