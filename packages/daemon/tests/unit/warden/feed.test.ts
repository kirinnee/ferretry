import { describe, it } from 'bun:test';
import type { WardenAction } from '@ferretry/protocol';
import should from 'should';
import {
  blessingViews,
  coverageAssignments,
  heldActions,
  investigationList,
  retainRecords,
  WARDEN_STATUS_LIST_LIMIT,
  type WardenAttentionView,
  wardenFeedView,
  type WardenSessionStatus,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const action = (overrides: Partial<WardenAction> = {}): WardenAction => ({
  at: at(-10),
  sessionId: 's1',
  action: 'stop',
  outcome: 'held',
  by: 'warden',
  detail: 'The Warden recommends stopping it: looping. It waits for you.',
  ...overrides,
});

const alive = (): WardenSessionStatus => 'running';

const projection = (overrides: Partial<WardenAttentionView> = {}): WardenAttentionView => ({
  generatedAt: at(0),
  outcome: 'clean-sweep',
  items: [],
  boardsWithParseErrors: [],
  verdictCoverage: { limit: 100, truncated: false },
  ...overrides,
});

describe('actions that wait on the owner', () => {
  it('should keep a recent hold on a live ferret', () => {
    // Act
    const actual = heldActions([action()], alive, NOW);

    // Assert
    should(actual).deepEqual([action()]);
  });

  it('should drop a hold a later act of the same kind settled', () => {
    // Act
    const actual = heldActions([action({ outcome: 'done', at: at(-1) }), action()], alive, NOW);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should keep only the newest hold of one act on one ferret', () => {
    // Act
    const actual = heldActions([action({ at: at(-1) }), action({ at: at(-5) })], alive, NOW);

    // Assert
    should(actual).have.length(1);
  });

  it.each([
    ['older than a day', action({ at: at(-25 * 60) }), alive],
    ['on a finished ferret', action(), (): WardenSessionStatus => 'stopped'],
    ['on a ferret that is gone', action(), (): undefined => undefined],
    ['with no readable instant', action({ at: 'never' }), alive],
  ] as const)('should drop a hold %s', (_label, entry, statusOf) => {
    // Act / Assert
    should(heldActions([entry], statusOf, NOW)).deepEqual([]);
  });
});

describe('the "who needs you" feed on the wire', () => {
  it('should add held actions as rows of their own, with the recommendation and the report', () => {
    // Arrange
    const held = action({ reportPath: '/r.md', anomalyKind: 'sus_thinking' });

    // Act
    const actual = wardenFeedView({
      projection: projection(),
      actions: [held, action({ sessionId: 's2', action: 'failover', agent: 'claude-work', detail: 'move' })],
      statusOf: alive,
      names: new Map([['s1', { teammate: 'Kofi', label: 'pairing' }]]),
      nowMs: NOW,
    });

    // Assert
    should(actual.outcome).equal('items');
    should(actual.items[0]).deepEqual({
      sessionId: 's1',
      teammate: 'Kofi',
      label: 'pairing',
      id: 'action:stop:s1',
      source: 'warden-action',
      subject: 'The Warden recommends stopping it',
      why: held.detail,
      waitingSince: held.at,
      howToResolve: 'Open the ferret and stop it, or leave it running.',
      recommendation: { action: 'stop', reason: held.detail },
      anomalyKind: 'sus_thinking',
      judgement: { state: 'judged', reason: held.detail, reportPath: '/r.md', at: held.at },
    });
    should(actual.items[1]).match({
      subject: 'The Warden recommends an action',
      howToResolve: 'Open the ferret and decide whether to do it.',
      recommendation: { action: 'migrate', agent: 'claude-work' },
    });
  });

  it('should name a held blessing as "leave"', () => {
    // Act
    const actual = wardenFeedView({
      projection: projection(),
      actions: [action({ action: 'bless' })],
      statusOf: alive,
      names: new Map(),
      nowMs: NOW,
    });

    // Assert
    should(actual.items[0]?.recommendation?.action).equal('leave');
  });

  it('should tag a flag row with its anomaly kind and keep the projection’s own outcome when nothing is held', () => {
    // Arrange
    const flag = {
      sessionId: 's1',
      id: 'anomaly:sus_thinking:s1',
      source: 'warden-anomaly' as const,
      subject: 'Session may be stuck thinking',
      why: 'thinking',
      waitingSince: at(-5),
      howToResolve: 'Open the session and decide what to do.',
      fromAnomaly: true,
      judgement: { state: 'none' as const, reason: 'No matching warden judgement yet.' },
    };
    const board = { ...flag, id: 'A1', source: 'question' as const, fromAnomaly: undefined, judgement: undefined };

    // Act
    const items = wardenFeedView({
      projection: projection({ outcome: 'items', items: [flag, board], lastSweepAt: at(-1) }),
      actions: [],
      statusOf: alive,
      names: new Map(),
      nowMs: NOW,
    });
    const degraded = wardenFeedView({
      projection: projection({
        outcome: 'degraded',
        wardenDegraded: { reason: 'boards' },
        boardsWithParseErrors: [{ sessionId: 's9', parseErrors: 2 }],
      }),
      actions: [],
      statusOf: alive,
      names: new Map(),
      nowMs: NOW,
    });

    // Assert
    should(items.items[0]?.anomalyKind).equal('sus_thinking');
    should(items.items[1]).not.have.property('anomalyKind');
    should(items.lastSweepAt).equal(at(-1));
    should(degraded).match({ outcome: 'degraded', wardenDegraded: { reason: 'boards' } });
    should(degraded.boardsWithParseErrors).deepEqual([{ sessionId: 's9', parseErrors: 2 }]);
  });
});

describe('the flags a live fleet warden covers', () => {
  it('should read as assignments while that warden is live', () => {
    // Arrange
    const coverage = {
      wardenId: 'w9',
      reportPath: '/r.md',
      anomalies: [
        { sessionId: 's1', kind: 'abandoned_wreckage' as const },
        { sessionId: 's1', kind: 'quota_reset_passed' as const },
        { sessionId: 's2', kind: 'declared_wait_overdue' as const },
      ],
    };

    // Act
    const live = coverageAssignments(coverage, () => true);
    const gone = coverageAssignments(coverage, () => false);
    const none = coverageAssignments(undefined, () => true);

    // Assert
    should(live).deepEqual({
      s1: { wardenId: 'w9', kinds: ['abandoned_wreckage', 'quota_reset_passed'] },
      s2: { wardenId: 'w9', kinds: ['declared_wait_overdue'] },
    });
    should(gone).deepEqual({});
    should(none).deepEqual({});
  });
});

describe('the blessings in force', () => {
  it('should list the unexpired ones, a warden’s when nobody is named', () => {
    // Act
    const actual = blessingViews(
      {
        s1: {
          sessionId: 's1',
          kinds: ['sus_thinking'],
          status: 'thinking',
          blessedAt: at(-1),
          expiresAt: at(10),
          by: 'jev',
        },
        s2: { sessionId: 's2', kinds: ['sus_subprocess'], status: 'running', blessedAt: at(-1), expiresAt: at(5) },
        s3: { sessionId: 's3', kinds: ['sus_thinking'], status: 'running', blessedAt: at(-30), expiresAt: at(-1) },
      },
      NOW,
    );

    // Assert
    should(actual).deepEqual([
      { sessionId: 's1', kinds: ['sus_thinking'], expiresAt: at(10), by: 'jev' },
      { sessionId: 's2', kinds: ['sus_subprocess'], expiresAt: at(5), by: 'warden' },
    ]);
  });
});

describe('the investigations list', () => {
  it('should put the queue first, then started ones as running or done', () => {
    // Act
    const actual = investigationList({
      queue: [
        { kind: 'owner_request', sessionId: 's1', status: 'running', detail: 'look' },
        { kind: 'sus_thinking', sessionId: 's2', status: 'thinking', detail: 'think' },
      ],
      meta: { s1: { queuedAt: at(-2), origin: 'owner' } },
      records: [
        {
          id: 'w2',
          scope: 'session',
          origin: 'jev',
          targetId: 's3',
          anomalyKind: 'sus_thinking',
          startedAt: at(-3),
          reportPath: '/w2.md',
          agent: 'claude-default',
          model: 'opus',
        },
        {
          id: 'w1',
          scope: 'fleet',
          origin: 'sweep',
          startedAt: at(-30),
          finishedAt: at(-20),
          reportPath: '/w1.md',
          verdict: 'cleared',
          costUsd: 0.31,
        },
      ],
      live: id => id === 'w2',
    });

    // Assert
    should(actual).deepEqual([
      {
        id: 'queued:s1',
        state: 'queued',
        scope: 'session',
        origin: 'owner',
        targetSession: 's1',
        anomalyKind: 'owner_request',
        queuedAt: at(-2),
      },
      {
        id: 'queued:s2',
        state: 'queued',
        scope: 'session',
        origin: 'sweep',
        targetSession: 's2',
        anomalyKind: 'sus_thinking',
      },
      {
        id: 'w2',
        state: 'running',
        scope: 'session',
        origin: 'jev',
        targetSession: 's3',
        anomalyKind: 'sus_thinking',
        wardenSession: 'w2',
        startedAt: at(-3),
        reportPath: '/w2.md',
        agent: 'claude-default',
        model: 'opus',
      },
      {
        id: 'w1',
        state: 'done',
        scope: 'fleet',
        origin: 'sweep',
        wardenSession: 'w1',
        startedAt: at(-30),
        finishedAt: at(-20),
        reportPath: '/w1.md',
        verdict: 'cleared',
        costUsd: 0.31,
      },
    ]);
  });

  it('should list at most the status limit', () => {
    // Act
    const actual = investigationList({
      queue: Array.from({ length: WARDEN_STATUS_LIST_LIMIT + 5 }, (_, index) => ({
        kind: 'sus_thinking' as const,
        sessionId: `s${index}`,
        status: 'thinking' as const,
        detail: 'd',
      })),
      meta: {},
      records: [],
      live: () => false,
    });

    // Assert
    should(actual).have.length(WARDEN_STATUS_LIST_LIMIT);
  });
});

describe('what the state remembers', () => {
  it('should keep the newest beyond the limit only when they are from today', () => {
    // Arrange
    const records = [
      { id: 'a', startedAt: '2026-10-16T10:00:00.000Z' },
      { id: 'b', startedAt: '2026-10-15T10:00:00.000Z' },
      { id: 'c', startedAt: '2026-10-16T01:00:00.000Z' },
      { id: 'd', at: '2026-10-14T01:00:00.000Z' },
      { id: 'e' },
    ];

    // Act
    const actual = retainRecords(records, '2026-10-16', 1);

    // Assert
    should(actual.map(record => record.id)).deepEqual(['a', 'c']);
  });
});
