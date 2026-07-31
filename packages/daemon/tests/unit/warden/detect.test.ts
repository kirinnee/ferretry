import { describe, it } from 'bun:test';
import should from 'should';
import {
  declaredWaitDeadlineMs,
  detectAnomalies,
  fingerprintAnomalies,
  isTerminalStatus,
  isWardenScannableStatus,
  WAITING_BACKSTOP_MS,
  WARDEN_LABEL,
  type WardenAnomaly,
  type WardenDetectOptions,
  type WardenSessionConfig,
  type WardenSessionState,
  type WardenSessionView,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const options: WardenDetectOptions = {
  unattendedMs: 15 * 60_000,
  terminalWindowMs: 60 * 60_000,
  susThinkingSeconds: 600,
  susSubprocessSeconds: 900,
};

const view = (
  id: string,
  state: WardenSessionState,
  config: Partial<WardenSessionConfig> = {},
  extras: { hasLiveMonitor?: boolean; hasDoneMarker?: boolean } = {},
): WardenSessionView => ({
  config: { id, mode: 'auto', createdAt: ago(600), updatedAt: ago(600), ...config },
  state,
  hasLiveMonitor: extras.hasLiveMonitor ?? true,
  hasDoneMarker: extras.hasDoneMarker,
});

const kinds = (anomalies: readonly WardenAnomaly[]): readonly string[] => anomalies.map(anomaly => anomaly.kind);

describe('warden status predicates', () => {
  it.each([
    { status: 'running' as const, scannable: true, terminal: false },
    { status: 'waiting' as const, scannable: true, terminal: false },
    { status: 'completed' as const, scannable: false, terminal: true },
    { status: 'kill_failed' as const, scannable: false, terminal: true },
    { status: 'created' as const, scannable: false, terminal: false },
  ])('should classify $status consistently', ({ status, scannable, terminal }) => {
    // Arrange / Act / Assert
    should(isWardenScannableStatus(status)).eql(scannable);
    should(isTerminalStatus(status)).eql(terminal);
  });
});

describe('declared wait deadlines', () => {
  it('should use an explicit until when it parses', () => {
    // Arrange / Act
    const deadline = declaredWaitDeadlineMs({ since: ago(120), until: ago(30) });

    // Assert
    should(deadline).eql(Date.parse(ago(30)));
  });

  it('should fall back to the backstop measured from since for an open-ended wait', () => {
    // Arrange / Act
    const deadline = declaredWaitDeadlineMs({ since: ago(60) });

    // Assert
    should(deadline).eql(Date.parse(ago(60)) + WAITING_BACKSTOP_MS);
  });

  it('should yield no deadline when the wait carries no usable anchor', () => {
    // Arrange / Act
    const deadline = declaredWaitDeadlineMs({ since: 'garbage', until: 'garbage' });

    // Assert
    should(deadline).be.undefined();
  });
});

describe('fleet anomaly detection', () => {
  it('should flag an actively working session with no live monitor handle', () => {
    // Arrange
    const sessions = [view('s1', { status: 'thinking', startedAt: ago(1) }, {}, { hasLiveMonitor: false })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['dead_monitor']);
    should(result.anomalies[0]?.detail).containEql('no live monitor handle');
  });

  it('should carry the teammate and label onto every anomaly it raises', () => {
    // Arrange
    const sessions = [
      view(
        's1',
        { status: 'running', startedAt: ago(1) },
        { teammate: 'atlas', label: 'batch-7' },
        { hasLiveMonitor: false },
      ),
    ];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies[0]?.teammate).eql('atlas');
    should(result.anomalies[0]?.label).eql('batch-7');
  });

  it('should never flag a warden session', () => {
    // Arrange
    const sessions = [view('w1', { status: 'thinking' }, { label: WARDEN_LABEL }, { hasLiveMonitor: false })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
    should(result.fingerprint).eql('');
  });

  it('should never flag a descendant of a warden that is only in the full fleet index', () => {
    // Arrange — the warden itself already finished, so the live sweep slice
    // holds only its child.
    const warden = view('w1', { status: 'completed' }, { label: WARDEN_LABEL });
    const child = view('c1', { status: 'thinking' }, { parent: 'w1' }, { hasLiveMonitor: false });

    // Act
    const result = detectAnomalies([child], NOW, options, [warden]);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should terminate lineage resolution on a parent cycle', () => {
    // Arrange
    const left = view('a', { status: 'thinking' }, { parent: 'b' }, { hasLiveMonitor: false });
    const right = view('b', { status: 'running' }, { parent: 'a' }, { hasLiveMonitor: false });

    // Act
    const result = detectAnomalies([left, right], NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['dead_monitor', 'dead_monitor']);
  });

  it('should never flag an interactive session however long it idles', () => {
    // Arrange
    const sessions = [
      view(
        'i1',
        { status: 'awaiting_question', lastActivityAt: ago(4_000) },
        { mode: 'interactive' },
        { hasLiveMonitor: false },
      ),
    ];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should flag a question nobody answered once it passes the unattended threshold', () => {
    // Arrange
    const sessions = [view('s1', { status: 'awaiting_question', lastActivityAt: ago(40) })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['unattended_question']);
    should(result.anomalies[0]?.idleMinutes).eql(40);
    should(result.anomalies[0]?.assignedWarden).be.true();
  });

  it('should leave a freshly asked question alone', () => {
    // Arrange
    const sessions = [view('s1', { status: 'awaiting_user', lastActivityAt: ago(2) })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should anchor an unattended question on creation when no activity was ever recorded', () => {
    // Arrange
    const sessions = [view('s1', { status: 'awaiting_question' }, { createdAt: ago(90) })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies[0]?.idleMinutes).eql(90);
    should(result.anomalies[0]?.since).eql(ago(90));
  });

  it('should still flag a question with no timestamps at all', () => {
    // Arrange
    const sessions = [view('s1', { status: 'awaiting_question' }, { createdAt: undefined })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['unattended_question']);
    should(result.anomalies[0]?.idleMinutes).be.undefined();
    should(result.anomalies[0]?.since).be.undefined();
    should(result.anomalies[0]?.detail).containEql('the whole session');
  });

  it('should treat a declared wait as deliberate rather than unattended', () => {
    // Arrange
    const sessions = [
      view('s1', { status: 'waiting', lastActivityAt: ago(120), waiting: { since: ago(120), until: ago(-60) } }),
    ];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should flag a declared wait whose deadline passed without a wake', () => {
    // Arrange
    const until = ago(30);
    const sessions = [view('s1', { status: 'waiting', waiting: { since: ago(120), until } })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['declared_wait_overdue']);
    should(result.anomalies[0]?.since).eql(until);
    should(result.anomalies[0]?.detail).containEql(until);
  });

  it('should describe an open-ended overdue wait by its backstop', () => {
    // Arrange
    const sessions = [view('s1', { status: 'waiting', waiting: { since: ago(300) } })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['declared_wait_overdue']);
    should(result.anomalies[0]?.detail).containEql('open-ended backstop');
  });

  it('should not fabricate an overdue deadline for a wait with an unparseable since', () => {
    // Arrange
    const sessions = [view('s1', { status: 'waiting', waiting: { since: 'whenever' } })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should ignore a declared wait recorded on a session that already settled', () => {
    // Arrange
    const sessions = [view('s1', { status: 'stopped', waiting: { since: ago(4_000), peer: 'ghost' } })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should flag a peer wait whose peer reached a terminal state', () => {
    // Arrange
    const peer = view('p1', { status: 'failed', finishedAt: ago(5_000) });
    const waiter = view('s1', { status: 'waiting', waiting: { since: ago(5), peer: 'p1', peerName: 'nova' } });

    // Act
    const result = detectAnomalies([waiter], NOW, options, [waiter, peer]);

    // Assert
    should(kinds(result.anomalies)).eql(['peer_wait_unanswerable']);
    should(result.anomalies[0]?.detail).containEql('nova');
    should(result.anomalies[0]?.detail).containEql('can never reply');
    should(result.anomalies[0]?.assignedWarden).be.true();
  });

  it('should flag a peer wait whose peer is not a known session', () => {
    // Arrange
    const sessions = [view('s1', { status: 'waiting', waiting: { since: ago(5), peer: 'ghost' } })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['peer_wait_unanswerable']);
    should(result.anomalies[0]?.detail).containEql('not a known session');
  });

  it('should leave a peer wait alone while the peer can still reply', () => {
    // Arrange
    const peer = view('p1', { status: 'running', startedAt: ago(1) });
    const waiter = view('s1', { status: 'waiting', waiting: { since: ago(5), peer: 'p1' } });

    // Act
    const result = detectAnomalies([waiter, peer], NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should ignore a wait that names itself as the peer', () => {
    // Arrange
    const sessions = [view('s1', { status: 'waiting', waiting: { since: ago(5), peer: 's1' } })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should flag recent wreckage that was never resumed or stopped', () => {
    // Arrange
    const sessions = [view('s1', { status: 'failed', finishedAt: ago(10), reason: 'harness exited 1' })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['abandoned_wreckage']);
    should(result.anomalies[0]?.detail).containEql('harness exited 1');
  });

  it('should omit the reason clause when the failure recorded none', () => {
    // Arrange
    const sessions = [view('s1', { status: 'stalled', finishedAt: ago(10) })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies[0]?.detail).eql('stalled within the sweep window and never resumed or stopped');
  });

  it('should ignore wreckage older than the sweep window', () => {
    // Arrange
    const sessions = [view('s1', { status: 'failed', finishedAt: ago(600) })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should not let a later config write drag ancient wreckage back into the sweep window', () => {
    // Arrange — the failure is hours old but the config was rewritten a minute ago.
    const sessions = [view('s1', { status: 'failed', finishedAt: ago(600) }, { updatedAt: ago(1) })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should fall back to the last activity when a failure recorded no finish time', () => {
    // Arrange
    const sessions = [view('s1', { status: 'failed', lastActivityAt: ago(5) })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['abandoned_wreckage']);
  });

  it('should ignore a failure with no usable timestamps at all', () => {
    // Arrange
    const sessions = [view('s1', { status: 'failed' }, { updatedAt: undefined })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should never call a session with a done marker abandoned wreckage', () => {
    // Arrange
    const sessions = [view('s1', { status: 'failed', finishedAt: ago(10) }, {}, { hasDoneMarker: true })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });

  it('should flag a silent think and attach the liveness ledger for the assigned warden', () => {
    // Arrange
    const sessions = [
      view('s1', {
        status: 'thinking',
        startedAt: ago(120),
        lastCounterAdvanceAt: ago(0.1),
        lastTranscriptAt: ago(30),
      }),
    ];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['sus_thinking']);
    should(result.anomalies[0]?.idleMinutes).eql(30);
    should(result.anomalies[0]?.ledger?.lastTranscriptAt).eql(ago(30));
  });

  it('should report no idle minutes for a sus think whose transcript never grew', () => {
    // Arrange
    const sessions = [view('s1', { status: 'thinking', lastCounterAdvanceAt: ago(0.1) })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['sus_thinking']);
    should(result.anomalies[0]?.idleMinutes).be.undefined();
  });

  it('should not also classify an unmonitored session as sus', () => {
    // Arrange
    const sessions = [
      view(
        's1',
        { status: 'thinking', startedAt: ago(120), lastCounterAdvanceAt: ago(0.1), lastTranscriptAt: ago(30) },
        {},
        { hasLiveMonitor: false },
      ),
    ];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['dead_monitor']);
  });

  it('should use the session tick when judging whether the work indicator is current', () => {
    // Arrange — 90s since the last counter advance is stale at a 30s tick but
    // current at a 60s tick.
    const state: WardenSessionState = {
      status: 'thinking',
      startedAt: ago(120),
      lastCounterAdvanceAt: ago(1.5),
      lastTranscriptAt: ago(30),
    };

    // Act
    const fastTick = detectAnomalies([view('s1', state, { intervalSeconds: 30 })], NOW, options);
    const slowTick = detectAnomalies([view('s1', state, { intervalSeconds: 60 })], NOW, options);

    // Assert
    should(fastTick.anomalies).be.empty();
    should(kinds(slowTick.anomalies)).eql(['sus_thinking']);
  });

  it('should flag a rate-limited session whose quota reset already passed', () => {
    // Arrange
    const resetAt = NOW - 60_000;
    const sessions = [view('s1', { status: 'rate_limited', quota: { resetAt } })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(kinds(result.anomalies)).eql(['quota_reset_passed']);
    should(result.anomalies[0]?.since).eql(new Date(resetAt).toISOString());
  });

  it.each([
    { label: 'a reset still in the future', quota: { resetAt: NOW + 60_000 } },
    { label: 'a non-finite reset', quota: { resetAt: Number.NaN } },
    { label: 'no quota record', quota: undefined },
  ])('should leave a rate-limited session with $label alone', ({ quota }) => {
    // Arrange
    const sessions = [view('s1', { status: 'rate_limited', quota })];

    // Act
    const result = detectAnomalies(sessions, NOW, options);

    // Assert
    should(result.anomalies).be.empty();
  });
});

describe('anomaly fingerprints', () => {
  it('should be empty for a clean sweep', () => {
    // Arrange / Act
    const result = detectAnomalies([], NOW, options);

    // Assert
    should(result.fingerprint).eql('');
  });

  it('should be order-independent and ignore volatile fields', () => {
    // Arrange
    const left: WardenAnomaly = { kind: 'dead_monitor', sessionId: 'a', status: 'running', detail: 'x', since: ago(1) };
    const right: WardenAnomaly = { kind: 'unattended_question', sessionId: 'b', status: 'waiting', detail: 'y' };

    // Act / Assert
    should(fingerprintAnomalies([left, right])).eql(fingerprintAnomalies([right, left]));
    should(fingerprintAnomalies([left, right])).eql('dead_monitor:a|unattended_question:b');
  });

  it('should prefer a fleet key over the session id so one outage stays one item', () => {
    // Arrange
    const anomaly: WardenAnomaly = {
      kind: 'provider_unavailable',
      sessionId: 's1',
      fleetKey: 'provider:acme',
      provider: 'acme',
      affectedSessionIds: ['s1', 's2'],
      status: 'failed',
      detail: 'acme is refusing every request',
    };

    // Act / Assert
    should(fingerprintAnomalies([anomaly])).eql('provider_unavailable:provider:acme');
  });
});
