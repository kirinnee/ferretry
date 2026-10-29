import { describe, it } from 'bun:test';
import type { WardenAction } from '@ferretry/protocol';
import should from 'should';
import {
  blessingViews,
  heldActions,
  investigationList,
  retainRecords,
  WARDEN_STATUS_LIST_LIMIT,
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

describe('housekeeping is never a hold', () => {
  it('should never keep a held leftover cleanup, which is listed under Recent actions instead', () => {
    // Act / Assert
    should(heldActions([action({ action: 'close_leftover' })], alive, NOW)).deepEqual([]);
  });
});
