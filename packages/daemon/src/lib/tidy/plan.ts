/**
 * TIDY — the one decision behind `fy tidy` (docs/board.md, "Tidy"): which of a ferret's own cards to drop,
 * which of its own agenda items to close, and what to keep and why.
 *
 * Pure. The service gathers the facts; this decides, so a dry run, the real run and the tests share one
 * rule and nothing here can write.
 *
 * A card is dropped only when it is the ferret's own errand on a board nobody switched on: the card is the
 * ferret's (owner or assignee), still open, asked by an agent, on a board that is off, assigned to no other
 * live session and not waiting at a gate on the owner. An agenda item is closed only when it is the ferret's
 * own, raised by it, and only tracks work; anything that asks the owner something is listed and left.
 */
import {
  type AgendaItem,
  agendaCardKind,
  agendaTitle,
  type BoardTask,
  type BoardTaskAskedBy,
  type BoardTaskId,
  type TidyClose,
  type TidyDrop,
  type TidyKeep,
  type TidyPlan,
} from '@ferretry/protocol';

/** What the decision needs to know about one card. */
export interface TidyCardFact {
  readonly id: BoardTaskId;
  readonly title: string;
  readonly projectId: BoardTask['projectId'];
  readonly owner: string;
  /** The session doing it; `null` means the owner ferret is. */
  readonly assignee: string | null;
  readonly askedBy: BoardTaskAskedBy;
  /** In a closed lane, or dropped: nothing left to tidy. */
  readonly finished: boolean;
}

export interface TidyFacts {
  readonly sessionId: string;
  readonly subFerret: boolean;
  /** This machine's id: a `task` link naming another machine's card is never one of the cards dropped here. */
  readonly machineId: string | undefined;
  readonly cards: readonly TidyCardFact[];
  /** The projects whose board switch is on. An unreadable switch is off, so it is not in this set. */
  readonly boardsOn: ReadonlySet<BoardTask['projectId']>;
  /** Sessions with an agent still running or waiting, not stopped, failed or finished. */
  readonly liveSessions: ReadonlySet<string>;
  /** Cards an open gate item waits on the owner for. */
  readonly gateCards: ReadonlySet<string>;
  /** The caller's open agenda items, in any state: active, snoozed, replied, in discussion. */
  readonly items: readonly AgendaItem[];
  /** Items the owner has answered and the ferret has not yet been told, or is being told now. */
  readonly replying: ReadonlySet<string>;
}

const effectiveAssignee = (card: TidyCardFact): string => card.assignee ?? card.owner;

const isTheirs = (card: TidyCardFact, sessionId: string): boolean =>
  card.owner === sessionId || card.assignee === sessionId;

/** The first reason a card must stay, or `undefined` when it is the ferret's own unwanted card. */
const cardKeep = (card: TidyCardFact, facts: TidyFacts): Extract<TidyKeep, { kind: 'task' }> | undefined => {
  const keep = (code: Extract<TidyKeep, { kind: 'task' }>['code'], why: string) =>
    ({ kind: 'task', id: card.id, title: card.title, code, why }) as const;
  if (card.askedBy === 'person') return keep('owner-asked', 'the owner asked for it');
  if (facts.boardsOn.has(card.projectId)) return keep('board-on', 'the board is on, so the card is wanted');
  const doing = effectiveAssignee(card);
  if (doing !== facts.sessionId && facts.liveSessions.has(doing)) {
    return keep('assigned-to-live-session', `${doing} is still working it`);
  }
  if (facts.gateCards.has(card.id)) return keep('waiting-at-gate', 'it waits at a gate on the owner');
  return undefined;
};

/** Whether an item asks the owner something: a question, a form, options or a held change. */
const asksOwner = (item: AgendaItem): boolean =>
  (item.questions?.length ?? 0) > 0 ||
  (item.fields?.length ?? 0) > 0 ||
  (item.ask !== undefined && item.ask.kind !== 'task') ||
  item.confirms !== undefined ||
  item.input !== undefined;

const subjectOf = (item: AgendaItem): string => agendaTitle(item);

const closes = (item: AgendaItem, code: TidyClose['code'], why: string): TidyClose => ({
  id: item.id,
  subject: subjectOf(item),
  code,
  why,
});

const keepsItem = (item: AgendaItem, code: Extract<TidyKeep, { kind: 'agenda' }>['code'], why: string): TidyKeep => ({
  kind: 'agenda',
  id: item.id,
  title: subjectOf(item),
  code,
  why,
});

type ItemVerdict = { readonly close: TidyClose } | { readonly keep: TidyKeep };

const judgeItem = (item: AgendaItem, facts: TidyFacts, dropped: ReadonlySet<string>): ItemVerdict => {
  if (item.gate !== undefined || item.raisedBy === 'daemon') {
    return { keep: keepsItem(item, 'gate', 'the daemon raised it for a card gate; the owner answers it') };
  }
  if (item.raisedBy !== 'agent' || item.raisedBySession !== facts.sessionId) {
    return { keep: keepsItem(item, 'not-yours', 'you did not raise it') };
  }
  if (facts.replying.has(item.id) || item.undelivered !== undefined) {
    return { keep: keepsItem(item, 'owner-replying', 'the owner is answering it now') };
  }
  if (asksOwner(item)) {
    return {
      keep: keepsItem(item, 'needs-owner', `it asks the owner; close it by hand with: fy agenda done ${item.id}`),
    };
  }
  if (agendaCardKind(item) === 'info') return { close: closes(item, 'info', 'it only informs; nothing to decide') };
  const link = item.task;
  if (link != null && dropped.has(link.id) && (link.machineId === undefined || link.machineId === facts.machineId)) {
    return { close: closes(item, 'card-dropped', `its card ${link.id} is dropped by this run`) };
  }
  if (agendaCardKind(item) === 'task') {
    return { close: closes(item, 'status-only', 'it asks no question and offers no choice; it only tracks work') };
  }
  return {
    keep: keepsItem(item, 'needs-owner', `it asks the owner; close it by hand with: fy agenda done ${item.id}`),
  };
};

/** Decide a ferret's tidy. Cards and agenda items are independent lists; a sub-ferret's plan has no cards. */
export const planTidy = (facts: TidyFacts): TidyPlan => {
  const keep: TidyKeep[] = [];
  const drop: TidyDrop[] = [];
  const candidates = facts.subFerret
    ? []
    : facts.cards.filter(card => !card.finished && isTheirs(card, facts.sessionId));
  for (const card of candidates) {
    const reason = cardKeep(card, facts);
    if (reason === undefined) {
      drop.push({ id: card.id, title: card.title, why: 'the board is off and nobody but you asked for it' });
    } else {
      keep.push(reason);
    }
  }
  const dropped = new Set(drop.map(each => each.id));
  const close: TidyClose[] = [];
  for (const item of facts.items) {
    const verdict = judgeItem(item, facts, dropped);
    if ('close' in verdict) close.push(verdict.close);
    else keep.push(verdict.keep);
  }
  return { v: 1, sessionId: facts.sessionId, subFerret: facts.subFerret, drop, close, keep };
};
