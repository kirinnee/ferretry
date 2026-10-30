import { describe, it } from 'bun:test';
import should from 'should';
import { AttentionActionRequestSchema, AttentionItemSchema } from '../../src/lib/attention.ts';
import * as boardModule from '../../src/lib/board.ts';
import {
  AgendaRefSchema,
  BOARD_EVENT_TYPES,
  BoardActivityFilterSchema,
  BoardActorSchema,
  BoardChangedEventSchema,
  BoardClarificationSchema,
  BoardCountsSchema,
  BoardDependencySchema,
  BoardDropSchema,
  BoardEditableFieldSchema,
  BoardErrorCodeSchema,
  BoardLinkFieldSchema,
  BoardPrStateFilterSchema,
  BoardQuarantinedCardSchema,
  BoardQuerySchema,
  BoardResponseSchema,
  BoardStateFilterSchema,
  type BoardTask,
  BoardTaskActionRequestSchema,
  BoardTaskActivitySchema,
  BoardTaskCreateRequestSchema,
  BoardTaskEventSchema,
  BoardTaskLinksSchema,
  BoardTaskResponseSchema,
  BoardTaskSchema,
  type BoardTaskView,
  BoardTaskViewSchema,
  BoardTermSchema,
  BoardTermsSchema,
  DependencyOverrideSchema,
  ExternalBlockSchema,
  formatAgendaRef,
  isInBoardState,
  LaneSetActionRequestSchema,
  laneEditProblems,
  LegacyTaskRefSchema,
  moveReasonProblem,
  type PrLink,
  PrChecksSchema,
  PrLinkSchema,
  PrStateSchema,
  prUrlParts,
  ReleasedInSchema,
  RollupSchema,
  taskIdPrefix,
} from '../../src/lib/board.ts';
import { LANE_TEMPLATES, type LaneSet, LaneSetSchema } from '../../src/lib/board-lanes.ts';
import { DAEMON_FEATURES, daemonFeatureList } from '../../src/lib/daemon-features.ts';
import { INSTANT, LATER_INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT = '00000000-0000-4000-8000-000000000002';
const SHA = 'a'.repeat(40);
const LEAD = 'mvuc7tsf-0c3d50df';
const CHILD = 'mvudnuly-ec442385';

const LANES: LaneSet = {
  projectId: PROJECT,
  version: 1,
  confirmedBy: 'owner',
  proposedBy: LEAD,
  ...LANE_TEMPLATES['pr-release-verify'],
};

const FERRET = { kind: 'ferret', sessionId: CHILD } as const;
const OWNER = { kind: 'owner' } as const;
const DAEMON = { kind: 'daemon' } as const;

const PR_URL = 'https://github.com/kirinnee/ferretry/pull/940';
const linkedPr: PrLink = {
  url: PR_URL,
  number: 940,
  repo: 'kirinnee/ferretry',
  state: 'unknown',
  draft: false,
  checks: 'none',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: null,
};
const RELEASE = { version: '4.110.0', tag: 'v4.110.0', at: LATER_INSTANT };
const mergedPr: PrLink = {
  ...linkedPr,
  state: 'merged',
  checks: 'passing',
  mergedAt: INSTANT,
  mergeSha: SHA,
  releasedIn: RELEASE,
  polledAt: LATER_INSTANT,
};

const event = <T extends Record<string, unknown>>(seq: number, body: T) => ({
  seq,
  at: INSTANT,
  actor: FERRET,
  ...body,
});

/** Every history event type, once each, in a gap-free run. */
const HISTORY = [
  event(1, { type: 'created', laneId: 'todo' }),
  event(2, { type: 'moved', from: 'todo', to: 'implement', backward: false, reason: null }),
  {
    ...event(3, { type: 'moved', from: 'implement', to: 'review', backward: false, reason: null }),
    actor: DAEMON,
    auto: true,
    trigger: 'pr.opened',
  },
  {
    ...event(4, { type: 'reopened', from: 'tested', to: 'implement', reason: 'the toggle does nothing' }),
    actor: OWNER,
    ask: { text: 'the toggle does nothing', source: 'owner:board' },
  },
  event(5, { type: 'note', text: 'local checkout stale' }),
  event(6, { type: 'clarified', text: 'also on the phone', source: `session:${LEAD}` }),
  event(7, { type: 'linked', field: 'pr', value: PR_URL }),
  event(8, { type: 'assigned', from: null, to: CHILD }),
  event(9, { type: 'depended', task: { id: 'F18' }, until: 'shipped' }),
  {
    ...event(10, { type: 'depended', task: { id: 'F18' }, until: 'shipped' }),
    actor: OWNER,
    override: { by: 'owner', reason: 'ship together', at: INSTANT },
  },
  event(11, { type: 'undepended', task: { id: 'F18' }, reason: 'merged into this card' }),
  event(12, { type: 'blocked', reason: 'waiting on GitHub' }),
  event(13, { type: 'unblocked', reason: null }),
  event(14, { type: 'field-edited', field: 'summary' }),
  event(15, { type: 'file-claimed', path: 'packages/protocol/src/lib/board.ts' }),
  event(16, { type: 'file-released', path: 'packages/protocol/src/lib/board.ts', reason: null }),
  event(17, { type: 'ordered', from: null, to: 3 }),
  event(18, {
    type: 'refiled',
    fromProject: 'unfiled',
    toProject: PROJECT,
    toLane: 'implement',
    reason: 'found its repo',
  }),
  event(19, { type: 'dropped', reason: 'superseded by &F20' }),
  { ...event(20, { type: 'migrated', legacyRef: `${LEAD}:F12` }), actor: DAEMON },
];

const CARD: BoardTask = BoardTaskSchema.parse({
  v: 1,
  id: 'F412',
  machineId: 'kirin-box',
  projectId: PROJECT,
  laneId: 'implement',
  kind: 'feature',
  title: 'Board protocol v2',
  summary: 'Wire shapes for project boards, lanes and cards.',
  ask: { text: 'flesh out the board system', source: `session:${LEAD}` },
  clarifications: [{ text: 'sub-ferrets write directly', source: 'owner', at: INSTANT, by: OWNER }],
  premise: 'Discipline alone does not keep the record.',
  context: '#319, #320',
  terms: [{ term: 'Lane', meaning: 'a project-defined column with a fixed category' }],
  brief: '# U1\n\nBuild the protocol.',
  owner: LEAD,
  assignee: CHILD,
  parent: { id: 'F18' },
  dependsOn: [{ task: { id: 'B3' }, until: 'released' }],
  blocked: null,
  dropped: null,
  workflow: 'quick',
  links: { prs: [linkedPr], branch: 'feat/board-protocol-v2', commits: [SHA], docs: ['/tmp/board-design.md'] },
  files: ['packages/protocol/src/lib/board.ts'],
  order: 0,
  createdAt: INSTANT,
  createdBy: { kind: 'daemon', sessionId: LEAD },
  history: HISTORY,
  legacyRef: `${LEAD}:F12`,
});

const ROLLUP = {
  children: 3,
  byCategory: { backlog: 1, active: 1, review: 1, shipped: 0, verify: 0, closed: 0 },
  active: 1,
  lastTouchedAt: INSTANT,
};

const VIEW: BoardTaskView = BoardTaskViewSchema.parse({
  ...CARD,
  lastTouchedAt: LATER_INSTANT,
  touchedBy: CHILD,
  activity: 'waiting',
  rollup: ROLLUP,
  suggestedLane: 'review',
  waitingOnOwner: [{ sessionId: CHILD, id: 'A12' }],
  openAsks: [
    { sessionId: CHILD, id: 'A12' },
    { sessionId: CHILD, id: 'A9' },
  ],
  blockedBy: [{ id: 'B3' }],
  blocks: [{ id: 'F20' }],
  shippedIn: null,
});

const COUNTS = { closedHidden: 214, stale: 2, orphaned: 1, active: 6, toTest: 2, waitingOnYou: 1 };
const BOARD = { projectId: PROJECT, laneSet: LANES, cards: [VIEW], counts: COUNTS, nextCursor: null, quarantined: [] };

const VALID: readonly SchemaCase[] = [
  { name: 'agenda ref', schema: AgendaRefSchema, value: { sessionId: CHILD, id: 'A48' } },
  { name: 'ferret actor', schema: BoardActorSchema, value: FERRET },
  { name: 'owner actor in a chat', schema: BoardActorSchema, value: { kind: 'owner', sessionId: LEAD } },
  { name: 'clarification', schema: BoardClarificationSchema, value: CARD.clarifications[0] },
  { name: 'term', schema: BoardTermSchema, value: CARD.terms[0] },
  { name: 'terms', schema: BoardTermsSchema, value: CARD.terms },
  { name: 'override', schema: DependencyOverrideSchema, value: { by: 'owner', reason: 'ship it', at: INSTANT } },
  { name: 'dependency', schema: BoardDependencySchema, value: CARD.dependsOn[0] },
  {
    name: 'external block',
    schema: ExternalBlockSchema,
    value: { on: 'external', reason: 'GitHub down', since: INSTANT },
  },
  { name: 'drop', schema: BoardDropSchema, value: { reason: 'superseded', at: INSTANT } },
  { name: 'released in', schema: ReleasedInSchema, value: RELEASE },
  { name: 'pre-release', schema: ReleasedInSchema, value: { ...RELEASE, version: '4.110.0-rc.1' } },
  { name: 'pr state', schema: PrStateSchema, value: 'merged' },
  { name: 'pr checks', schema: PrChecksSchema, value: 'failing' },
  { name: 'linked pr', schema: PrLinkSchema, value: linkedPr },
  { name: 'merged pr', schema: PrLinkSchema, value: mergedPr },
  {
    name: 'open pr',
    schema: PrLinkSchema,
    value: { ...linkedPr, state: 'open', draft: true, checks: 'pending', polledAt: INSTANT },
  },
  { name: 'links', schema: BoardTaskLinksSchema, value: CARD.links },
  { name: 'link field', schema: BoardLinkFieldSchema, value: 'commit' },
  { name: 'editable field', schema: BoardEditableFieldSchema, value: 'terms' },
  ...HISTORY.map(entry => ({ name: `event ${entry.type}`, schema: BoardTaskEventSchema, value: entry })),
  { name: 'legacy ref', schema: LegacyTaskRefSchema, value: `${LEAD}:F12` },
  { name: 'card', schema: BoardTaskSchema, value: CARD },
  { name: 'activity', schema: BoardTaskActivitySchema, value: 'orphaned' },
  { name: 'rollup', schema: RollupSchema, value: ROLLUP },
  { name: 'view', schema: BoardTaskViewSchema, value: VIEW },
  { name: 'pr filter', schema: BoardPrStateFilterSchema, value: 'ci_red' },
  { name: 'activity filter', schema: BoardActivityFilterSchema, value: 'to_test' },
  { name: 'state filter', schema: BoardStateFilterSchema, value: 'dropped' },
  { name: 'query', schema: BoardQuerySchema, value: { project: PROJECT, activity: 'waiting_on_you', query: 'tunnel' } },
  { name: 'counts', schema: BoardCountsSchema, value: COUNTS },
  { name: 'board', schema: BoardResponseSchema, value: BOARD },
  { name: 'all projects', schema: BoardResponseSchema, value: { ...BOARD, projectId: null, laneSet: null } },
  { name: 'unconfigured board', schema: BoardResponseSchema, value: { ...BOARD, laneSet: null } },
  { name: 'card response', schema: BoardTaskResponseSchema, value: { task: VIEW, laneSet: LANES } },
  {
    name: 'create',
    schema: BoardTaskCreateRequestSchema,
    value: { kind: 'bug', title: 'Tunnel credit burst', ask: CARD.ask },
  },
  {
    name: 'move',
    schema: BoardTaskActionRequestSchema,
    value: { action: 'move', to: 'implement', reason: 'plan agreed' },
  },
  { name: 'lanes propose', schema: LaneSetActionRequestSchema, value: { action: 'propose', template: 'pr' } },
  { name: 'error code', schema: BoardErrorCodeSchema, value: 'blocked-by' },
  { name: 'changed', schema: BoardChangedEventSchema, value: { projectId: 'unfiled', taskIds: ['F412', 'B3'] } },
  { name: 'quarantined', schema: BoardQuarantinedCardSchema, value: { id: 'F9', reason: 'history seq 4 is missing' } },
  {
    name: 'board with a bad card',
    schema: BoardResponseSchema,
    value: { ...BOARD, quarantined: [{ id: 'F9', reason: 'not JSON' }] },
  },
];

const INVALID: readonly SchemaCase[] = [
  { name: 'agenda ref without session', schema: AgendaRefSchema, value: { id: 'A1' } },
  { name: 'ferret actor without session', schema: BoardActorSchema, value: { kind: 'ferret' } },
  { name: 'unknown actor', schema: BoardActorSchema, value: { kind: 'human' } },
  { name: 'two-line term', schema: BoardTermSchema, value: { term: 'a\nb', meaning: 'x' } },
  { name: 'blank term', schema: BoardTermSchema, value: { term: ' ', meaning: 'x' } },
  {
    name: 'repeated term',
    schema: BoardTermsSchema,
    value: [
      { term: 'Lane', meaning: 'a' },
      { term: 'lane', meaning: 'b' },
    ],
  },
  { name: 'override by a ferret', schema: DependencyOverrideSchema, value: { by: 'ferret', reason: 'x', at: INSTANT } },
  { name: 'unknown until', schema: BoardDependencySchema, value: { task: { id: 'F1' }, until: 'merged' } },
  { name: 'block without reason', schema: ExternalBlockSchema, value: { on: 'external', reason: ' ', since: INSTANT } },
  { name: 'drop without reason', schema: BoardDropSchema, value: { reason: '', at: INSTANT } },
  { name: 'not a version', schema: ReleasedInSchema, value: { ...RELEASE, version: 'v4.110' } },
  {
    name: 'not a PR url',
    schema: PrLinkSchema,
    value: { ...linkedPr, url: 'https://github.com/kirinnee/ferretry/issues/940' },
  },
  { name: 'number disagrees', schema: PrLinkSchema, value: { ...linkedPr, number: 941 } },
  { name: 'repo disagrees', schema: PrLinkSchema, value: { ...linkedPr, repo: 'kirinnee/other' } },
  { name: 'unpolled but open', schema: PrLinkSchema, value: { ...linkedPr, state: 'open' } },
  { name: 'merged without sha', schema: PrLinkSchema, value: { ...mergedPr, mergeSha: null } },
  { name: 'merged without time', schema: PrLinkSchema, value: { ...mergedPr, mergedAt: null } },
  { name: 'open with a merge', schema: PrLinkSchema, value: { ...mergedPr, state: 'open', releasedIn: null } },
  {
    name: 'released unmerged',
    schema: PrLinkSchema,
    value: { ...linkedPr, state: 'closed', polledAt: INSTANT, releasedIn: RELEASE },
  },
  { name: 'short sha', schema: PrLinkSchema, value: { ...mergedPr, mergeSha: 'abc123' } },
  { name: 'pr linked twice', schema: BoardTaskLinksSchema, value: { ...CARD.links, prs: [linkedPr, linkedPr] } },
  { name: 'unknown event', schema: BoardTaskEventSchema, value: event(1, { type: 'status' }) },
  {
    name: 'event without actor',
    schema: BoardTaskEventSchema,
    value: { seq: 1, at: INSTANT, type: 'note', text: 'x' },
  },
  {
    name: 'move nowhere',
    schema: BoardTaskEventSchema,
    value: event(1, { type: 'moved', from: 'a', to: 'a', backward: false, reason: null }),
  },
  {
    name: 'backward move without reason',
    schema: BoardTaskEventSchema,
    value: event(1, { type: 'moved', from: 'review', to: 'implement', backward: true, reason: null }),
  },
  {
    name: 'auto move without trigger',
    schema: BoardTaskEventSchema,
    value: {
      ...event(1, { type: 'moved', from: 'todo', to: 'implement', backward: false, reason: null }),
      actor: DAEMON,
      auto: true,
    },
  },
  {
    name: 'trigger without auto',
    schema: BoardTaskEventSchema,
    value: {
      ...event(1, { type: 'moved', from: 'todo', to: 'implement', backward: false, reason: null }),
      actor: DAEMON,
      trigger: 'work.started',
    },
  },
  {
    name: 'auto move by a ferret',
    schema: BoardTaskEventSchema,
    value: {
      ...event(1, { type: 'moved', from: 'todo', to: 'implement', backward: false, reason: null }),
      auto: true,
      trigger: 'work.started',
    },
  },
  {
    name: 'reopen without reason',
    schema: BoardTaskEventSchema,
    value: { ...event(1, { type: 'reopened', from: 'tested', to: 'implement', reason: '' }), ask: CARD.ask },
  },
  {
    name: 'reopen without ask',
    schema: BoardTaskEventSchema,
    value: event(1, { type: 'reopened', from: 'tested', to: 'implement', reason: 'broken' }),
  },
  {
    name: 'undepend without reason',
    schema: BoardTaskEventSchema,
    value: event(1, { type: 'undepended', task: { id: 'F1' } }),
  },
  {
    name: 'edit of a non-field',
    schema: BoardTaskEventSchema,
    value: event(1, { type: 'field-edited', field: 'owner' }),
  },
  { name: 'bad legacy ref', schema: LegacyTaskRefSchema, value: 'F12' },
  { name: 'card from the future', schema: BoardTaskSchema, value: { ...CARD, v: 2 } },
  { name: 'six-word title', schema: BoardTaskSchema, value: { ...CARD, title: 'one two three four five six' } },
  { name: 'long summary', schema: BoardTaskSchema, value: { ...CARD, summary: 'x'.repeat(141) } },
  { name: 'two-line summary', schema: BoardTaskSchema, value: { ...CARD, summary: 'one\ntwo' } },
  { name: 'unknown workflow', schema: BoardTaskSchema, value: { ...CARD, workflow: 'someday' } },
  { name: 'empty history', schema: BoardTaskSchema, value: { ...CARD, history: [] } },
  { name: 'unknown activity', schema: BoardTaskActivitySchema, value: 'running' },
  { name: 'rollup that does not add up', schema: RollupSchema, value: { ...ROLLUP, children: 4 } },
  { name: 'more active than children', schema: RollupSchema, value: { ...ROLLUP, active: 4 } },
  {
    name: 'blocking ask that is not open',
    schema: BoardTaskViewSchema,
    value: { ...VIEW, openAsks: [{ sessionId: CHILD, id: 'A9' }] },
  },
  { name: 'view of an incoherent card', schema: BoardTaskViewSchema, value: { ...VIEW, kind: 'bug' } },
  { name: 'unknown pr filter', schema: BoardPrStateFilterSchema, value: 'closed' },
  { name: 'stray query field', schema: BoardQuerySchema, value: { lane: 'todo' } },
  { name: 'page too big', schema: BoardQuerySchema, value: { limit: 501 } },
  { name: 'empty text query', schema: BoardQuerySchema, value: { query: '  ' } },
  { name: 'negative count', schema: BoardCountsSchema, value: { ...COUNTS, stale: -1 } },
  { name: 'lanes across projects', schema: BoardResponseSchema, value: { ...BOARD, projectId: null } },
  {
    name: "another project's lanes",
    schema: BoardResponseSchema,
    value: { ...BOARD, laneSet: { ...LANES, projectId: OTHER_PROJECT } },
  },
  {
    name: "another project's card",
    schema: BoardResponseSchema,
    value: { ...BOARD, cards: [{ ...VIEW, projectId: OTHER_PROJECT }] },
  },
  {
    name: 'create with an actor',
    schema: BoardTaskCreateRequestSchema,
    value: { kind: 'bug', title: 'X', ask: CARD.ask, createdBy: OWNER },
  },
  { name: 'create without ask', schema: BoardTaskCreateRequestSchema, value: { kind: 'bug', title: 'X' } },
  { name: 'unknown action', schema: BoardTaskActionRequestSchema, value: { action: 'status', status: 'done' } },
  { name: 'unknown lanes action', schema: LaneSetActionRequestSchema, value: { action: 'delete' } },
  { name: 'unknown error', schema: BoardErrorCodeSchema, value: 'ambiguous' },
  { name: 'nothing changed', schema: BoardChangedEventSchema, value: { projectId: PROJECT, taskIds: [] } },
  {
    name: 'quarantined by path',
    schema: BoardQuarantinedCardSchema,
    value: { id: 'board/tasks/F9.json', reason: 'x' },
  },
];

const issuesOf = (value: unknown): string[] => {
  const parsed = BoardTaskSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map(issue => issue.message);
};

describe('board schemas', () => {
  it('should round-trip every valid shape and refuse the rest', () => {
    assertRoundTrips(VALID);
    assertRejects(INVALID);
    assertCoversEverySchema(boardModule, VALID);
  });

  it('should carry every history event type exactly once in the fixture', () => {
    should(new Set(HISTORY.map(entry => entry.type)).size).equal(BoardTaskEventSchema.options.length);
  });
});

describe('card invariants', () => {
  it('should match the id prefix to the kind', () => {
    should(issuesOf({ ...CARD, kind: 'bug' })).deepEqual(['task id prefix must match its kind']);
    should(['bug', 'feature', 'infra', 'chore'].map(kind => taskIdPrefix(kind as BoardTask['kind']))).deepEqual([
      'B',
      'F',
      'I',
      'C',
    ]);
  });

  it('should refuse a card that is its own parent, here or named with its machine', () => {
    should(issuesOf({ ...CARD, parent: { id: 'F412' } })).deepEqual(['a card is not its own parent']);
    should(issuesOf({ ...CARD, parent: { machineId: 'kirin-box', id: 'F412' } })).deepEqual([
      'a card is not its own parent',
    ]);
    should(issuesOf({ ...CARD, parent: { machineId: 'mac', id: 'F412' } })).deepEqual([]);
  });

  it('should refuse a dependency on itself or a dependency listed twice', () => {
    should(issuesOf({ ...CARD, dependsOn: [{ task: { id: 'F412' }, until: 'shipped' }] })).deepEqual([
      'a card does not depend on itself',
    ]);
    const twice = [
      { task: { id: 'B3' }, until: 'shipped' },
      { task: { id: 'B3' }, until: 'released' },
    ];
    should(issuesOf({ ...CARD, dependsOn: twice })).deepEqual(['each dependency is listed once']);
    const elsewhere = [
      { task: { id: 'B3' }, until: 'shipped' },
      { task: { machineId: 'mac', id: 'B3' }, until: 'shipped' },
    ];
    should(issuesOf({ ...CARD, dependsOn: elsewhere })).deepEqual([]);
  });

  it('should refuse a file claimed twice', () => {
    should(issuesOf({ ...CARD, files: ['a.ts', 'a.ts'] })).deepEqual(['each file is listed once']);
  });

  it('should keep history gap-free and opened by its one created event', () => {
    should(issuesOf({ ...CARD, history: [HISTORY[0], { ...HISTORY[4], seq: 3 }] })).deepEqual([
      'history seq runs 1, 2, 3… with no gap',
    ]);
    should(issuesOf({ ...CARD, history: [{ ...HISTORY[4], seq: 1 }] })).deepEqual([
      'history opens with its one created event',
    ]);
    should(issuesOf({ ...CARD, history: [HISTORY[0], { ...HISTORY[0], seq: 2 }] })).deepEqual([
      'history opens with its one created event',
    ]);
  });

  it('should keep an external block and a drop on the card', () => {
    // Act
    const card = BoardTaskSchema.parse({
      ...CARD,
      blocked: { on: 'external', reason: 'waiting on GitHub', since: INSTANT },
      dropped: { reason: 'superseded', at: INSTANT },
    });

    // Assert
    should(card.blocked?.reason).equal('waiting on GitHub');
    should(card.dropped?.reason).equal('superseded');
  });
});

describe('board helpers', () => {
  it('should write an agenda ref with its own sigil', () => {
    should(formatAgendaRef({ sessionId: CHILD, id: 'A48' })).equal('!A48');
  });

  it('should read a GitHub PR URL, and nothing else', () => {
    should(prUrlParts(PR_URL)).deepEqual({ repo: 'kirinnee/ferretry', number: 940 });
    should(prUrlParts('https://gitlab.com/a/b/-/merge_requests/1')).be.null();
  });

  it('should hide closed and dropped cards from the open board', () => {
    const cases: [boardModule.BoardStateFilter, 'implement' | 'closed', boolean, boolean][] = [
      ['open', 'implement', false, true],
      ['open', 'closed', false, false],
      ['open', 'implement', true, false],
      ['closed', 'closed', false, true],
      ['closed', 'implement', false, false],
      ['closed', 'closed', true, false],
      ['dropped', 'implement', true, true],
      ['dropped', 'implement', false, false],
      ['all', 'closed', true, true],
      ['all', 'implement', false, true],
    ];
    for (const [filter, laneId, dropped, expected] of cases) {
      const category = laneId === 'closed' ? 'closed' : 'active';
      should(isInBoardState(filter, category, dropped)).equal(expected);
    }
  });

  it('should need a reason only for a move back', () => {
    should(moveReasonProblem(LANES, 'implement', 'review', undefined)).deepEqual({ ok: true, value: undefined });
    should(moveReasonProblem(LANES, 'tested', 'implement', 'the toggle does nothing')).deepEqual({
      ok: true,
      value: undefined,
    });
    for (const missing of [undefined, '   ']) {
      should(moveReasonProblem(LANES, 'tested', 'implement', missing)).deepEqual({
        ok: false,
        error: { code: 'reason-required', from: 'tested', to: 'implement' },
      });
    }
    should(moveReasonProblem(LANES, 'ghost', 'implement', 'x')).deepEqual({
      ok: false,
      error: { code: 'unknown-lane', laneId: 'ghost' },
    });
  });

  it('should name the lanes an edit removes without saying where their cards go', () => {
    // Arrange
    const kept = LANES.lanes.filter(lane => lane.id !== 'plan' && lane.id !== 'released');

    // Act + Assert
    should(laneEditProblems(LANES, { layout: { lanes: kept }, relocate: {} })).deepEqual(['plan', 'released']);
    should(
      laneEditProblems(LANES, { layout: { lanes: kept }, relocate: { plan: 'implement', released: 'merged' } }),
    ).deepEqual([]);
  });

  it('should name the fleet feed event a board change is published as', () => {
    should(BOARD_EVENT_TYPES.changed).equal('board.changed');
  });
});

describe('board query', () => {
  it('should default to the open board, a hundred cards at a time', () => {
    should(BoardQuerySchema.parse({})).deepEqual({ state: 'open', limit: 100 });
  });

  it('should filter on activity states and the one-tap views', () => {
    should(BoardActivityFilterSchema.options).deepEqual([
      'active',
      'idle',
      'stale',
      'waiting',
      'orphaned',
      'to_test',
      'waiting_on_you',
      'blocked',
    ]);
  });
});

describe('board mutations', () => {
  const action = (value: Record<string, unknown>) => BoardTaskActionRequestSchema.safeParse(value).success;

  it('should fill a new card’s defaults', () => {
    should(BoardTaskCreateRequestSchema.parse({ kind: 'feature', title: 'Board page', ask: CARD.ask })).deepEqual({
      kind: 'feature',
      title: 'Board page',
      summary: '',
      ask: CARD.ask,
      premise: '',
      context: '',
      terms: [],
      brief: '',
      workflow: 'quick',
      parent: null,
      assignee: null,
      dependsOn: [],
      files: [],
      docs: [],
    });
    should(
      BoardTaskCreateRequestSchema.parse({
        kind: 'feature',
        title: 'X',
        ask: CARD.ask,
        dependsOn: [{ task: { id: 'F1' } }],
      }).dependsOn,
    ).deepEqual([{ task: { id: 'F1' }, until: 'shipped' }]);
  });

  it('should accept every action in its own shape', () => {
    const accepted = [
      { action: 'move', to: 'review' },
      { action: 'focus' },
      { action: 'block', reason: 'waiting on GitHub' },
      { action: 'unblock' },
      { action: 'depend', task: { id: 'F18' }, override: { reason: 'ship together' } },
      { action: 'undepend', task: { id: 'F18' }, reason: 'not needed' },
      { action: 'drop', reason: 'superseded' },
      { action: 'reopen', to: 'implement', reason: 'broken', ask: { text: 'broken', source: 'owner:board' } },
      { action: 'clarify', text: 'also the phone', source: 'owner' },
      { action: 'link', pr: PR_URL },
      { action: 'link', branch: 'feat/x' },
      { action: 'link', commit: SHA },
      { action: 'link', doc: 'docs/board.md' },
      { action: 'assign', assignee: null },
      { action: 'note', text: 'checked' },
      { action: 'edit', title: 'Board page' },
      { action: 'edit', terms: [{ term: 'Lane', meaning: 'a column' }] },
      { action: 'file', path: 'a.ts', release: true, reason: 'done' },
      { action: 'order', order: 2 },
      { action: 'refile', projectId: PROJECT },
    ];
    should(accepted.filter(value => !action(value))).deepEqual([]);
    should(BoardTaskActionRequestSchema.parse({ action: 'depend', task: { id: 'F18' } })).deepEqual({
      action: 'depend',
      task: { id: 'F18' },
      until: 'shipped',
    });
  });

  it('should refuse a link that names none or two things, an empty edit, and a reasonless drop', () => {
    const refused = [
      { action: 'link' },
      { action: 'link', pr: PR_URL, branch: 'feat/x' },
      { action: 'link', pr: 'https://example.com/pr/1' },
      { action: 'edit' },
      { action: 'edit', owner: LEAD },
      { action: 'drop' },
      { action: 'block', reason: '' },
      { action: 'reopen', to: 'implement', reason: 'broken' },
      { action: 'move', to: 'Review' },
    ];
    should(refused.filter(value => action(value))).deepEqual([]);
  });

  it('should propose from a template, with renames defaulted', () => {
    should(LaneSetActionRequestSchema.parse({ action: 'propose', template: 'ops' })).deepEqual({
      action: 'propose',
      template: 'ops',
      renames: {},
    });
    should(
      LaneSetActionRequestSchema.safeParse({ action: 'propose', template: 'ops', renames: { Fix: 'x' } }).success,
    ).be.false();
    should(LaneSetActionRequestSchema.safeParse({ action: 'confirm', version: 2 }).success).be.true();
  });

  it('should take a lane edit only when its relocations point into the new set', () => {
    // Arrange
    const lanes = LANE_TEMPLATES.pr.lanes.filter(lane => lane.id !== 'plan');
    const layout = { lanes, variants: {} };
    const edit = (relocate: Record<string, string>) =>
      LaneSetActionRequestSchema.safeParse({ action: 'edit', version: 1, layout, relocate });

    // Act + Assert
    should(edit({ plan: 'implement' }).success).be.true();
    should(edit({ implement: 'review' }).error?.issues.map(issue => issue.message)).deepEqual([
      'lane implement is kept, so it has no relocation',
    ]);
    should(edit({ plan: 'ghost' }).error?.issues.map(issue => issue.message)).deepEqual([
      'cards go to a lane of the new set, not ghost',
    ]);
    should(
      LaneSetActionRequestSchema.safeParse({
        action: 'edit',
        version: 1,
        layout: { lanes: lanes.slice(1), variants: {} },
      }).success,
    ).be.false();
  });

  it('should keep every template sound when parsed as a stored lane set', () => {
    should(LaneSetSchema.safeParse(LANES).success).be.true();
  });
});

describe('agenda seam', () => {
  const item = {
    id: 'A1',
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Approve the board design?',
    why: 'Implementation waits on it.',
    waitingSince: INSTANT,
    howToResolve: 'Approve or discuss.',
    raisedBy: 'agent',
    raisedBySession: CHILD,
    raisedByName: null,
  } as const;
  const add = { action: 'add', subject: item.subject, why: item.why, howToResolve: item.howToResolve } as const;

  it('should store the card an agenda item belongs to, and read an older item as having none', () => {
    should(AttentionItemSchema.parse({ ...item, task: { id: 'F18' } }).task).deepEqual({ id: 'F18' });
    should(AttentionItemSchema.parse({ ...item, task: null }).task).be.null();
    should(AttentionItemSchema.parse(item).task).be.undefined();
    should(AttentionItemSchema.safeParse({ ...item, task: { id: 'A1' } }).success).be.false();
  });

  it('should let an add name its card, and refuse a malformed one', () => {
    should(AttentionActionRequestSchema.parse({ ...add, task: { id: 'F18' } })).containDeep({ task: { id: 'F18' } });
    should(AttentionActionRequestSchema.parse(add)).not.have.property('task');
    should(AttentionActionRequestSchema.safeParse({ ...add, task: 'F18' }).success).be.false();
  });

  it('should gate an add that names a card on a daemon feature', () => {
    should(DAEMON_FEATURES.agendaTask).equal('agenda.task.1');
    should(daemonFeatureList()).containEql('agenda.task.1');
  });
});
