import { describe, it } from 'bun:test';
import should from 'should';
import {
  beginReadinessWait,
  decideReadiness,
  decideShutdown,
  defaultReadinessPolicy,
  defaultShutdownPolicy,
} from '../../../src/lib/daemon/readiness';

const policy = { deadlineMs: 90_000, cadenceMs: 250, progressAfterMs: 10_000 };

describe('readiness policy defaults', () => {
  it('should allow a boot far longer than the ten seconds that used to time out', () => {
    // Act
    const actual = defaultReadinessPolicy();

    // Assert — a schema rebuild or a 30s bind retry legitimately exceeds ten seconds.
    should(actual.deadlineMs).equal(90_000);
    should(actual.cadenceMs).equal(250);
    should(actual.progressAfterMs).equal(10_000);
  });
});

describe('readiness decisions', () => {
  it('should start out having seen nothing', () => {
    // Act
    const actual = beginReadinessWait(1_000);

    // Assert
    should(actual).deepEqual({ startedAtMs: 1_000, sawAlive: false, progressNoted: false });
  });

  it('should keep waiting while the process is not yet visible', () => {
    // Act
    const actual = decideReadiness(beginReadinessWait(0), 'absent', 500, policy);

    // Assert
    should(actual.kind).equal('continue');
  });

  it('should remember that the process was seen alive', () => {
    // Act
    const actual = decideReadiness(beginReadinessWait(0), 'alive', 500, policy);

    // Assert
    should(actual.kind).equal('continue');
    should(actual.kind === 'continue' && actual.state.sawAlive).be.true();
  });

  it('should NOT presume death on a dead verdict it has never seen alive', () => {
    // Act — a supervisor that has not started the job yet reports dead; concluding failure here would
    // turn every start into a spurious error.
    const actual = decideReadiness(beginReadinessWait(0), 'dead', 500, policy);

    // Assert
    should(actual.kind).equal('continue');
  });

  it('should fast-fail once a process it saw alive is gone', () => {
    // Arrange
    const seen = decideReadiness(beginReadinessWait(0), 'alive', 100, policy);

    // Act
    const actual = decideReadiness(seen.kind === 'continue' ? seen.state : beginReadinessWait(0), 'dead', 200, policy);

    // Assert
    should(actual.kind).equal('exited');
  });

  it('should note progress exactly once, after the progress threshold', () => {
    // Arrange
    const state = beginReadinessWait(0);

    // Act
    const first = decideReadiness(state, 'absent', 10_000, policy);
    const second = decideReadiness(first.kind === 'progress' ? first.state : state, 'absent', 20_000, policy);

    // Assert
    should(first.kind).equal('progress');
    should(first.kind === 'progress' && first.elapsedSeconds).equal(10);
    should(second.kind).equal('continue');
  });

  it('should round the reported elapsed seconds', () => {
    // Act
    const actual = decideReadiness(beginReadinessWait(0), 'absent', 12_600, policy);

    // Assert
    should(actual.kind === 'progress' && actual.elapsedSeconds).equal(13);
  });

  it('should time out at the deadline', () => {
    // Act
    const actual = decideReadiness(beginReadinessWait(0), 'absent', 90_000, policy);

    // Assert
    should(actual.kind).equal('timeout');
  });

  it('should prefer the exited verdict over a simultaneous timeout, because it says more', () => {
    // Arrange
    const seen = decideReadiness(beginReadinessWait(0), 'alive', 100, policy);

    // Act
    const actual = decideReadiness(seen.kind === 'continue' ? seen.state : beginReadinessWait(0), 'dead', 95_000, policy);

    // Assert
    should(actual.kind).equal('exited');
  });
});

describe('shutdown policy defaults', () => {
  it('should escalate well before it gives up', () => {
    // Act
    const actual = defaultShutdownPolicy();

    // Assert
    should(actual.escalateAfterMs).be.below(actual.deadlineMs);
    should(actual.deadlineMs).equal(20_000);
    should(actual.cadenceMs).equal(100);
  });
});

describe('shutdown decisions', () => {
  const shutdown = { deadlineMs: 20_000, cadenceMs: 100, escalateAfterMs: 10_000 };

  it('should keep waiting while a polite stop still has time', () => {
    // Act + Assert
    should(decideShutdown(0, false, shutdown)).equal('wait');
    should(decideShutdown(9_999, false, shutdown)).equal('wait');
  });

  it('should escalate once the polite stop has had its window', () => {
    // Act + Assert — kteam slept a flat 500ms and started the successor regardless.
    should(decideShutdown(10_000, false, shutdown)).equal('escalate');
  });

  it('should escalate only once', () => {
    // Act + Assert
    should(decideShutdown(15_000, true, shutdown)).equal('wait');
  });

  it('should give up at the deadline even after escalating', () => {
    // Act + Assert
    should(decideShutdown(20_000, true, shutdown)).equal('give-up');
    should(decideShutdown(20_000, false, shutdown)).equal('give-up');
  });
});
