import { describe, it } from 'bun:test';
import type { WardenAction } from '@ferretry/protocol';
import should from 'should';
import {
  jevHandoffKey,
  type WardenAnomaly,
  type WardenInvestigationRecord,
  type WardenJevHandoff,
  type WardenLayersInEffect,
  type WardenOwnerRouteInput,
  wardenOwnerRoutes,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const OFF: WardenLayersInEffect = {
  jev: { configured: false, active: false, reason: 'configured' },
  llm: { configured: false, active: false, reason: 'configured' },
};
const JEV_ONLY: WardenLayersInEffect = { ...OFF, jev: { configured: true, active: true, reason: 'configured' } };
const INVESTIGATING: WardenLayersInEffect = {
  ...JEV_ONLY,
  llm: { configured: true, active: true, reason: 'configured' },
};

const anomaly = (overrides: Partial<WardenAnomaly> = {}): WardenAnomaly => ({
  kind: 'sus_thinking',
  sessionId: 's1',
  status: 'thinking',
  detail: 'the transcript has not grown for 40m',
  since: at(-40),
  ...overrides,
});

const handoff = (overrides: Partial<WardenJevHandoff> = {}): WardenJevHandoff => ({
  at: at(-5),
  status: 'thinking',
  why: 'unsure',
  confidence: 0.42,
  ...overrides,
});

const held = (overrides: Partial<WardenAction> = {}): WardenAction => ({
  at: at(-3),
  sessionId: 's1',
  action: 'stop',
  outcome: 'held',
  by: 'jev',
  anomalyKind: 'sus_thinking',
  detail: 'Jev recommends stopping it (99% sure): looping. It waits for you.',
  ...overrides,
});

const record = (overrides: Partial<WardenInvestigationRecord> = {}): WardenInvestigationRecord => ({
  id: 'w1',
  scope: 'session',
  origin: 'sweep',
  targetId: 's1',
  anomalyKind: 'sus_thinking',
  startedAt: at(-20),
  finishedAt: at(-10),
  reportPath: '/r.md',
  ...overrides,
});

const routes = (overrides: Partial<WardenOwnerRouteInput> = {}) =>
  wardenOwnerRoutes({
    anomalies: [anomaly()],
    state: {},
    layers: OFF,
    enabled: true,
    statusOf: () => 'thinking',
    liveWarden: () => false,
    nowMs: NOW,
    ...overrides,
  });

describe('which flags are the owner’s', () => {
  it('should hand the owner a flag nothing could look at, for as long as it stands', () => {
    // Act
    const actual = routes();

    // Assert
    should(actual).deepEqual([{ anomaly: anomaly(), reason: { kind: 'untriaged', layers: OFF }, evidenceAt: at(-40) }]);
  });

  it('should date an undated flag by nothing, so only an answer holds it back', () => {
    // Act / Assert
    should(routes({ anomalies: [anomaly({ since: undefined, kind: 'dead_monitor' })] })[0]).not.have.property(
      'evidenceAt',
    );
  });

  it('should say Jev handed it on, and how sure it was, when no investigation can follow', () => {
    // Act
    const actual = routes({
      layers: JEV_ONLY,
      state: { jevHandoffs: { [jevHandoffKey('s1', 'sus_thinking')]: handoff() } },
    });

    // Assert
    should(actual).deepEqual([
      { anomaly: anomaly(), reason: { kind: 'jev', handoff: handoff(), layers: JEV_ONLY }, evidenceAt: at(-5) },
    ]);
  });

  it('should not read a hand-on made while the ferret was in another status', () => {
    // Act
    const actual = routes({
      layers: JEV_ONLY,
      state: { jevHandoffs: { [jevHandoffKey('s1', 'sus_thinking')]: handoff({ status: 'running' }) } },
    });

    // Assert
    should(actual[0]?.reason.kind).equal('untriaged');
  });

  it('should leave every flag to the investigations while they can run', () => {
    // Act / Assert
    should(
      routes({ layers: INVESTIGATING, state: { jevHandoffs: { [jevHandoffKey('s1', 'sus_thinking')]: handoff() } } }),
    ).deepEqual([]);
  });

  it('should put a held act in front of the owner, whatever the layers', () => {
    // Act
    const actual = routes({ layers: INVESTIGATING, state: { actions: [held()] } });

    // Assert
    should(actual).deepEqual([{ anomaly: anomaly(), reason: { kind: 'held', action: held() }, evidenceAt: at(-3) }]);
  });

  it('should not borrow a hold of another kind or ferret', () => {
    // Act
    const actual = routes({ state: { actions: [held({ anomalyKind: 'agent_frozen' }), held({ sessionId: 's2' })] } });

    // Assert
    should(actual[0]?.reason.kind).equal('untriaged');
  });

  it('should say an investigation of this episode failed, when its report could not be read or classified', () => {
    // Act
    const unread = routes({ layers: INVESTIGATING, state: { investigations: [record()] } });
    const unknown = routes({ layers: INVESTIGATING, state: { investigations: [record({ verdict: 'unknown' })] } });

    // Assert
    should(unread).deepEqual([
      { anomaly: anomaly(), reason: { kind: 'investigation_failed', record: record() }, evidenceAt: at(-10) },
    ]);
    should(unknown[0]?.reason.kind).equal('investigation_failed');
  });

  it.each([
    ['one with a verdict', record({ verdict: 'nudged' })],
    ['one still running', record({ finishedAt: undefined })],
    ['one that finished before the flag began', record({ finishedAt: at(-50), startedAt: at(-55) })],
    ['one of another kind', record({ anomalyKind: 'agent_frozen' })],
    ['one of another ferret', record({ targetId: 's2' })],
    ['a fleet investigation', record({ scope: 'fleet' })],
  ])('should not call %s a failed investigation', (_label, entry) => {
    // Act / Assert
    should(routes({ layers: INVESTIGATING, state: { investigations: [entry] } })).deepEqual([]);
  });

  it('should judge only by the newest investigation of the flag', () => {
    // Act
    const actual = routes({
      layers: INVESTIGATING,
      state: { investigations: [record({ id: 'old', startedAt: at(-30) }), record({ id: 'new', verdict: 'nudged' })] },
    });
    const reversed = routes({
      layers: INVESTIGATING,
      state: { investigations: [record({ id: 'new', verdict: 'nudged' }), record({ id: 'old', startedAt: at(-30) })] },
    });

    // Assert
    should(actual).deepEqual([]);
    should(reversed).deepEqual([]);
  });

  it('should accept a failed investigation of a flag with no episode anchor', () => {
    // Act / Assert
    should(
      routes({
        layers: INVESTIGATING,
        anomalies: [anomaly({ since: undefined })],
        state: { investigations: [record()] },
      })[0]?.reason.kind,
    ).equal('investigation_failed');
  });

  it('should leave the owner’s own queued request to wait for investigations', () => {
    // Arrange
    const request = anomaly({ kind: 'owner_request' });

    // Act
    const waiting = routes({ anomalies: [request], state: { assignedQueue: [request] } });
    const notQueued = routes({ anomalies: [request] });

    // Assert
    should(waiting).deepEqual([]);
    should(notQueued[0]?.reason.kind).equal('untriaged');
  });
});

describe('what is never the owner’s', () => {
  it('should hand the owner nothing while the Warden is off', () => {
    // Act / Assert
    should(routes({ enabled: false, state: { actions: [held()] } })).deepEqual([]);
  });

  it.each<[string, Partial<WardenOwnerRouteInput>]>([
    ['a finished ferret', { statusOf: () => 'completed' }],
    ['a ferret the flag says finished', { statusOf: () => undefined, anomalies: [anomaly({ status: 'failed' })] }],
  ])('should hand the owner nothing about %s', (_label, overrides) => {
    // Act / Assert
    should(routes(overrides)).deepEqual([]);
  });

  it('should hand the owner nothing a blessing covers', () => {
    // Act
    const actual = routes({
      state: {
        blessings: {
          s1: { sessionId: 's1', kinds: ['sus_thinking'], status: 'thinking', blessedAt: at(-1), expiresAt: at(60) },
        },
      },
    });

    // Assert
    should(actual).deepEqual([]);
  });

  it('should hand the owner nothing whose subject the last look cleared', () => {
    // Act
    const actual = routes({
      anomalies: [anomaly({ subject: 'turn-4' })],
      state: { backoff: { 's1|sus_thinking': { subject: 'turn-4', lastAt: at(-5), count: 1, cleared: true } } },
    });

    // Assert
    should(actual).deepEqual([]);
  });

  it('should hand the owner nothing while a Jev act on the ferret is still landing', () => {
    // Act
    const actual = routes({
      state: {
        backoff: {
          's1|agent_frozen': {
            subject: 'turn-4',
            lastAt: at(-1),
            count: 1,
            jevActed: { action: 'nudge', at: at(-1), subject: 'turn-4', landsBy: at(5) },
          },
        },
      },
    });

    // Assert
    should(actual).deepEqual([]);
  });

  it('should hand the owner nothing an assigned warden is investigating', () => {
    // Act
    const actual = routes({
      state: {
        assignments: {
          s1: { wardenId: 'w1', spawnedAt: at(-1), capability: 'c', kinds: ['sus_thinking'], reportPath: '/r.md' },
        },
      },
    });

    // Assert
    should(actual).deepEqual([]);
  });

  it('should hand the owner nothing a live fleet warden covers, and the flag once that warden is gone', () => {
    // Arrange
    const sweepCoverage = {
      wardenId: 'w0',
      reportPath: '/f.md',
      anomalies: [{ sessionId: 's1', kind: 'sus_thinking' as const }],
    };
    const otherKind = { ...sweepCoverage, anomalies: [{ sessionId: 's1', kind: 'agent_frozen' as const }] };

    // Act
    const live = routes({ state: { sweepCoverage }, liveWarden: id => id === 'w0' });
    const gone = routes({ state: { sweepCoverage } });
    const other = routes({ state: { sweepCoverage: otherKind }, liveWarden: () => true });

    // Assert
    should(live).deepEqual([]);
    should(gone).have.length(1);
    should(other).have.length(1);
  });
});
