import { describe, it } from 'bun:test';
import should from 'should';
import { beginReadinessWait, decideReadiness, type ReadinessPolicy } from '../../../src/lib/runtime/readiness.ts';

const policy: ReadinessPolicy = { deadlineMs: 100, cadenceMs: 10, progressAfterMs: 20 };

describe('daemon readiness policy', () => {
  it('should create a clean wait state and publish progress once', () => {
    // Arrange
    const state = beginReadinessWait(10);

    // Act
    const first = decideReadiness(state, 'alive', 30, policy);
    if (first.kind !== 'progress') throw new Error('expected a progress decision');
    const second = decideReadiness(first.state, 'alive', 40, policy);

    // Assert
    should(state).deepEqual({ startedAtMs: 10, sawAlive: false, progressNoted: false });
    should(first).containDeep({ elapsedSeconds: 0, state: { sawAlive: true, progressNoted: true } });
    should(second).containDeep({ kind: 'continue', state: { sawAlive: true, progressNoted: true } });
  });

  it('should ignore stale dead pid state until this wait saw a live process', () => {
    // Arrange
    const initial = beginReadinessWait(0);

    // Act
    const stale = decideReadiness(initial, 'dead', 1, policy);
    const exited = decideReadiness({ ...initial, sawAlive: true }, 'dead', 1, policy);

    // Assert
    should(stale).containDeep({ kind: 'continue', state: { sawAlive: false } });
    should(exited).deepEqual({ kind: 'exited' });
  });

  it('should report a just-dead process even at the readiness deadline', () => {
    // Act + Assert
    should(decideReadiness({ ...beginReadinessWait(0), sawAlive: true }, 'dead', 100, policy)).deepEqual({
      kind: 'exited',
    });
    should(decideReadiness(beginReadinessWait(0), 'absent', 100, policy)).deepEqual({ kind: 'timeout' });
  });
});
