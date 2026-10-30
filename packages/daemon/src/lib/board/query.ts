/**
 * The board query (`GET /v1/board`): which cards a `BoardQuery` selects, in what order, one page at a
 * time, plus the header counts over the whole scoped board. Pure over already-derived views.
 *
 * SCOPE vs FILTER. The project, ferret, kind and free-text fields SCOPE the board: they decide which
 * board the header describes. State, activity and PR state are the views a person flips between on that
 * board (the pills, the Archive), so they FILTER the page and never change the counts.
 */
import {
  type BoardCounts,
  type BoardPrStateFilter,
  type BoardQuery,
  type BoardTaskView,
  isInBoardState,
  type LaneCategory,
  type PrLink,
} from '@ferretry/protocol';
import { BoardError } from './errors.ts';

/** A view with the category of its lane; `undefined` when its board has no lanes this build knows. */
export interface ScopedView {
  readonly view: BoardTaskView;
  readonly category: LaneCategory | undefined;
}

const unmerged = (pr: PrLink): boolean => pr.state === 'open' || pr.state === 'unknown';

/** Whether a card's PRs match a PR-state filter. `unknown` (never polled yet) reads as open. */
export const matchesPrState = (filter: BoardPrStateFilter, prs: readonly PrLink[]): boolean => {
  switch (filter) {
    case 'none':
      return prs.length === 0;
    case 'draft':
      return prs.some(pr => pr.draft && unmerged(pr));
    case 'open':
      return prs.some(pr => !pr.draft && unmerged(pr));
    case 'ci_red':
      return prs.some(pr => pr.checks === 'failing' && unmerged(pr));
    case 'merged':
      return prs.some(pr => pr.state === 'merged' && pr.releasedIn === null);
    case 'released':
      return prs.some(pr => pr.releasedIn !== null);
  }
};

/** Whether a card is in a state filter. A card on a board with no known lanes is open unless dropped. */
const inState = (query: Pick<BoardQuery, 'state'>, scoped: ScopedView): boolean =>
  isInBoardState(query.state, scoped.category ?? 'backlog', scoped.view.dropped !== null);

const matchesActivity = (filter: NonNullable<BoardQuery['activity']>, scoped: ScopedView): boolean => {
  switch (filter) {
    case 'to_test':
      return scoped.category === 'verify';
    case 'waiting_on_you':
      return scoped.view.waitingOnOwner.length > 0;
    case 'blocked':
      return scoped.view.blocked !== null || scoped.view.blockedBy.length > 0;
    default:
      return scoped.view.activity === filter;
  }
};

/** Whether a card is on the board the query scopes. */
export const inScope = (query: BoardQuery, scoped: ScopedView): boolean => {
  const { view } = scoped;
  if (query.project !== undefined && view.projectId !== query.project) return false;
  if (query.ferret !== undefined && view.owner !== query.ferret && view.assignee !== query.ferret) return false;
  if (query.kind !== undefined && view.kind !== query.kind) return false;
  if (query.query !== undefined) {
    const needle = query.query.toLowerCase();
    const haystack = [view.id, view.title, view.summary, view.ask.text].join('\n').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
};

/** Whether a scoped card passes the page filters. */
export const passesFilters = (query: BoardQuery, scoped: ScopedView): boolean =>
  inState(query, scoped) &&
  (query.activity === undefined || matchesActivity(query.activity, scoped)) &&
  (query.prState === undefined || matchesPrState(query.prState, scoped.view.links.prs));

const isOpen = (scoped: ScopedView): boolean =>
  isInBoardState('open', scoped.category ?? 'backlog', scoped.view.dropped !== null);

/** The header's counts over the scoped board. Closed cards are "hidden" only while the page hides them. */
export const countsOf = (query: BoardQuery, scoped: readonly ScopedView[]): BoardCounts => {
  const open = scoped.filter(isOpen);
  const hidesClosed = query.state === 'open' || query.state === 'dropped';
  return {
    closedHidden: hidesClosed
      ? scoped.filter(entry => entry.view.dropped === null && entry.category === 'closed').length
      : 0,
    stale: open.filter(entry => entry.view.activity === 'stale').length,
    orphaned: open.filter(entry => entry.view.activity === 'orphaned').length,
    active: open.filter(entry => entry.view.activity === 'active').length,
    toTest: open.filter(entry => entry.category === 'verify').length,
    waitingOnYou: open.filter(entry => entry.view.waitingOnOwner.length > 0).length,
  };
};

/** The card's most recent history instant: when it last changed. */
const updatedAt = (view: BoardTaskView): string => view.history.at(-1)?.at ?? view.createdAt;

const idNumber = (id: string): number => Number(id.slice(1));

/**
 * Board order: a card's manual `order` first (unordered cards after), then the most recently changed,
 * then the id. Total, so a page boundary never moves between two reads of an unchanged board.
 */
export const compareViews = (left: BoardTaskView, right: BoardTaskView): number => {
  const leftOrder = left.order ?? Number.POSITIVE_INFINITY;
  const rightOrder = right.order ?? Number.POSITIVE_INFINITY;
  if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
  const leftAt = updatedAt(left);
  const rightAt = updatedAt(right);
  if (leftAt !== rightAt) return leftAt > rightAt ? -1 : 1;
  if (left.id[0] !== right.id[0]) return (left.id[0] ?? '') < (right.id[0] ?? '') ? -1 : 1;
  return idNumber(left.id) - idNumber(right.id);
};

const CURSOR = /^o([1-9][0-9]{0,8})$/u;

/** The cursor of the page that starts at `offset`. Opaque to clients. */
export const cursorFor = (offset: number): string => `o${offset}`;

/** The offset a cursor names. A cursor this daemon did not issue is the caller's mistake. */
export const offsetOf = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const match = CURSOR.exec(cursor);
  if (match === null)
    throw new BoardError('invalid', 'the cursor is not one this board issued; start from the first page');
  return Number(match[1]);
};

/** One page of the filtered, ordered cards, and the cursor of the next page (`null` on the last). */
export const pageOf = (
  query: BoardQuery,
  views: readonly BoardTaskView[],
): { readonly cards: readonly BoardTaskView[]; readonly nextCursor: string | null } => {
  const offset = offsetOf(query.cursor);
  const ordered = [...views].sort(compareViews);
  const cards = ordered.slice(offset, offset + query.limit);
  const end = offset + cards.length;
  return { cards, nextCursor: end < ordered.length ? cursorFor(end) : null };
};
