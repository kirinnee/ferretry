import { describe, it } from 'bun:test';
import {
  type BoardPrStateFilter,
  type BoardQueryInput,
  BoardQuerySchema,
  type BoardTask,
  type BoardTaskView,
  type LaneCategory,
  type PrLink,
} from '@ferretry/protocol';
import should from 'should';
import {
  BoardError,
  compareViews,
  countsOf,
  cursorFor,
  inScope,
  matchesPrState,
  offsetOf,
  pageOf,
  passesFilters,
  type ScopedView,
} from '../../../src/lib/board/index.ts';
import { card, NOW } from './support.ts';

const query = (input: BoardQueryInput = {}) => BoardQuerySchema.parse(input);

const view = (overrides: Partial<BoardTaskView> = {}, stored: Partial<BoardTask> = {}): BoardTaskView => ({
  ...card(stored),
  lastTouchedAt: null,
  touchedBy: null,
  activity: 'idle',
  rollup: {
    children: 0,
    byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
    active: 0,
    lastTouchedAt: null,
  },
  suggestedLane: null,
  waitingOnOwner: [],
  openAsks: [],
  blockedBy: [],
  blocks: [],
  shippedIn: null,
  ...overrides,
});

const scoped = (entry: BoardTaskView, category: LaneCategory | undefined = 'backlog'): ScopedView => ({
  view: entry,
  category,
});

const pr = (overrides: Partial<PrLink>): PrLink => ({
  url: 'https://github.com/kirinnee/ferretry/pull/1',
  number: 1,
  repo: 'kirinnee/ferretry',
  state: 'unknown',
  draft: false,
  checks: 'none',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: null,
  ...overrides,
});

describe('the PR state filter', () => {
  const merged = { state: 'merged' as const, mergedAt: NOW, mergeSha: 'a'.repeat(40), polledAt: NOW };
  it.each<{ filter: BoardPrStateFilter; prs: PrLink[]; expected: boolean }>([
    { filter: 'none', prs: [], expected: true },
    { filter: 'none', prs: [pr({})], expected: false },
    { filter: 'draft', prs: [pr({ draft: true })], expected: true },
    { filter: 'draft', prs: [pr({ draft: true, ...merged })], expected: false },
    { filter: 'open', prs: [pr({})], expected: true },
    { filter: 'open', prs: [pr({ state: 'open', polledAt: NOW, draft: true })], expected: false },
    { filter: 'ci_red', prs: [pr({ checks: 'failing', state: 'open', polledAt: NOW })], expected: true },
    { filter: 'ci_red', prs: [pr({ checks: 'failing', ...merged })], expected: false },
    { filter: 'merged', prs: [pr(merged)], expected: true },
    {
      filter: 'merged',
      prs: [pr({ ...merged, releasedIn: { version: '1.0.0', tag: 'v1.0.0', at: NOW } })],
      expected: false,
    },
    {
      filter: 'released',
      prs: [pr({ ...merged, releasedIn: { version: '1.0.0', tag: 'v1.0.0', at: NOW } })],
      expected: true,
    },
    { filter: 'released', prs: [pr(merged)], expected: false },
  ])('should read $filter as $expected', ({ filter, prs, expected }) => {
    // Act
    const actual = matchesPrState(filter, prs);

    // Assert
    should(actual).equal(expected);
  });
});

describe('the board scope', () => {
  it.each([
    { name: 'the project', input: { project: '11111111-1111-4111-8111-111111111111' }, expected: true },
    { name: 'another project', input: { project: 'unfiled' as const }, expected: false },
    { name: 'its owner', input: { ferret: 'lead' }, expected: true },
    { name: 'its assignee', input: { ferret: 'child' }, expected: true },
    { name: 'another ferret', input: { ferret: 'stranger' }, expected: false },
    { name: 'its kind', input: { kind: 'feature' as const }, expected: true },
    { name: 'another kind', input: { kind: 'bug' as const }, expected: false },
    { name: 'text in the ask', input: { query: 'THE BOARD' }, expected: true },
    { name: 'its id', input: { query: 'f1' }, expected: true },
    { name: 'text it lacks', input: { query: 'tunnel' }, expected: false },
  ])('should decide $name', ({ input, expected }) => {
    // Act
    const actual = inScope(query(input), scoped(view({}, { assignee: 'child' })));

    // Assert
    should(actual).equal(expected);
  });
});

describe('the page filters', () => {
  const dropped = { dropped: { reason: 'superseded', at: NOW } };
  it.each([
    { name: 'an open card on the open board', input: {}, entry: scoped(view()), expected: true },
    { name: 'a closed card on the open board', input: {}, entry: scoped(view(), 'closed'), expected: false },
    {
      name: 'a closed card on the closed board',
      input: { state: 'closed' as const },
      entry: scoped(view(), 'closed'),
      expected: true,
    },
    {
      name: 'a dropped card on the dropped board',
      input: { state: 'dropped' as const },
      entry: scoped(view({}, dropped)),
      expected: true,
    },
    {
      name: 'a card without known lanes on the open board',
      input: {},
      entry: scoped(view(), undefined),
      expected: true,
    },
    {
      name: 'a verify card to test',
      input: { activity: 'to_test' as const },
      entry: scoped(view(), 'verify'),
      expected: true,
    },
    { name: 'a backlog card to test', input: { activity: 'to_test' as const }, entry: scoped(view()), expected: false },
    {
      name: 'a card waiting on the owner',
      input: { activity: 'waiting_on_you' as const },
      entry: scoped(
        view({ waitingOnOwner: [{ sessionId: 'lead', id: 'A1' }], openAsks: [{ sessionId: 'lead', id: 'A1' }] }),
      ),
      expected: true,
    },
    {
      name: 'an unasked card waiting on the owner',
      input: { activity: 'waiting_on_you' as const },
      entry: scoped(view()),
      expected: false,
    },
    {
      name: 'an externally blocked card',
      input: { activity: 'blocked' as const },
      entry: scoped(view({}, { blocked: { on: 'external', reason: 'vendor', since: NOW } })),
      expected: true,
    },
    {
      name: 'a card blocked by another',
      input: { activity: 'blocked' as const },
      entry: scoped(view({ blockedBy: [{ id: 'F2' }] })),
      expected: true,
    },
    { name: 'a free card', input: { activity: 'blocked' as const }, entry: scoped(view()), expected: false },
    {
      name: 'a stale card',
      input: { activity: 'stale' as const },
      entry: scoped(view({ activity: 'stale' })),
      expected: true,
    },
    { name: 'an idle card', input: { activity: 'stale' as const }, entry: scoped(view()), expected: false },
    { name: 'a card with no PR', input: { prState: 'none' as const }, entry: scoped(view()), expected: true },
    {
      name: 'a card with no PR on the open-PR filter',
      input: { prState: 'open' as const },
      entry: scoped(view()),
      expected: false,
    },
  ])('should decide $name', ({ input, entry, expected }) => {
    // Act
    const actual = passesFilters(query(input), entry);

    // Assert
    should(actual).equal(expected);
  });
});

describe('the header counts', () => {
  const board = [
    scoped(view({ activity: 'active' }, { id: 'F1' }), 'active'),
    scoped(view({ activity: 'stale' }, { id: 'F2' }), 'active'),
    scoped(view({ activity: 'orphaned' }, { id: 'F3' }), 'review'),
    scoped(view({}, { id: 'F4' }), 'verify'),
    scoped(
      view(
        { waitingOnOwner: [{ sessionId: 'lead', id: 'A1' }], openAsks: [{ sessionId: 'lead', id: 'A1' }] },
        { id: 'F5' },
      ),
    ),
    scoped(view({ activity: 'stale' }, { id: 'F6' }), 'closed'),
    scoped(view({}, { id: 'F7', dropped: { reason: 'no', at: NOW } }), 'closed'),
  ];

  it('should count the open board and the closed cards it hides', () => {
    // Act
    const counts = countsOf(query(), board);

    // Assert
    should(counts).eql({ closedHidden: 1, stale: 1, orphaned: 1, active: 1, toTest: 1, waitingOnYou: 1 });
  });

  it('should hide nothing on a board that shows the closed cards', () => {
    // Act
    const counts = countsOf(query({ state: 'all' }), board);

    // Assert
    should(counts.closedHidden).equal(0);
    should(countsOf(query({ state: 'dropped' }), board).closedHidden).equal(1);
  });
});

describe('board order and pages', () => {
  const at = (minute: number) => `2026-10-30T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const touched = (id: string, minute: number, order: number | null = null) =>
    view(
      {},
      { id, order, history: [{ seq: 1, at: at(minute), actor: { kind: 'owner' }, type: 'created', laneId: 'todo' }] },
    );

  it('should order by manual order, then most recent, then id', () => {
    // Arrange
    const cards = [
      touched('F3', 1),
      touched('B9', 1),
      touched('F2', 1),
      touched('F1', 5),
      touched('C7', 1, 2),
      touched('F8', 1, 1),
    ];

    // Act
    const ordered = [...cards].sort(compareViews).map(entry => entry.id);

    // Assert
    should(ordered).eql(['F8', 'C7', 'F1', 'B9', 'F2', 'F3']);
  });

  it('should order equal cards as equal', () => {
    // Assert
    should(compareViews(touched('F1', 1), touched('F1', 1))).equal(0);
  });

  it('should page with a cursor until the last page', () => {
    // Arrange
    const cards = ['F1', 'F2', 'F3'].map(id => touched(id, 1));

    // Act
    const first = pageOf(query({ limit: 2 }), cards);
    const second = pageOf(query({ limit: 2, cursor: first.nextCursor ?? undefined }), cards);

    // Assert
    should(first.cards.map(entry => entry.id)).eql(['F1', 'F2']);
    should(first.nextCursor).equal(cursorFor(2));
    should(second.cards.map(entry => entry.id)).eql(['F3']);
    should(second.nextCursor).be.null();
  });

  it('should refuse a cursor it did not issue', () => {
    // Assert
    should(offsetOf(undefined)).equal(0);
    should(() => offsetOf('page-two')).throw(BoardError, { code: 'invalid' });
    should(() => offsetOf('o0')).throw(BoardError);
  });
});
