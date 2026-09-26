import { describe, it } from 'bun:test';
import should from 'should';
import {
  claimsRunningAgent,
  exitedSessionTransition,
  type SessionExitObservation,
  type SessionPaneExit,
} from '../../../../src/lib/session/health/exit.ts';

function observation(exit: SessionPaneExit, status = 'running'): SessionExitObservation {
  return {
    id: 'session',
    status,
    registration: {
      daemonId: 'daemon',
      sessionId: 'session',
      tmuxSession: 'fy-session',
      paneId: '%0',
      pid: 4242,
      processStartTicks: 99,
    },
    exit,
  };
}

describe('exited session transition', () => {
  it('should read a clean exit as finished', () => {
    // Act
    const actual = exitedSessionTransition(observation({ kind: 'exited', exitStatus: 0 }));

    // Assert
    should(actual).deepEqual({
      status: 'completed',
      health: 'idle',
      reason: 'the agent exited on its own (exit status 0)',
      exitCode: 0,
    });
  });

  it('should fail a non-zero exit and name its status', () => {
    // Act
    const actual = exitedSessionTransition(observation({ kind: 'exited', exitStatus: 137 }, 'tool_running'));

    // Assert
    should(actual).deepEqual({
      status: 'failed',
      health: 'crashed',
      reason: 'the agent exited on its own (exit status 137)',
      exitCode: 137,
    });
  });

  it('should fail a signalled exit as a crash naming the signal, without inventing an exit code', () => {
    // Act
    const actual = exitedSessionTransition(observation({ kind: 'exited', signal: 9 }));

    // Assert
    should(actual).deepEqual({ status: 'failed', health: 'crashed', reason: 'the agent was ended by signal 9' });
  });

  it('should fail an exit tmux kept no status for without calling it a crash', () => {
    // Act
    const actual = exitedSessionTransition(observation({ kind: 'exited' }));

    // Assert
    should(actual).deepEqual({
      status: 'failed',
      health: 'unknown',
      reason: 'the agent exited on its own; how it exited was not recorded',
    });
  });

  it('should fail a session whose terminal is gone without inventing an exit status', () => {
    // Act
    const actual = exitedSessionTransition(observation({ kind: 'gone' }, 'waiting'));

    // Assert
    should(actual).deepEqual({
      status: 'failed',
      health: 'unknown',
      reason: 'the agent is no longer running: its terminal is gone, so how it exited was not recorded',
    });
  });

  it('should decline a session whose status no longer claims a live agent', () => {
    // Act
    const actual = [
      'stopped',
      'completed',
      'failed',
      'starting',
      'created',
      'retrying',
      'rate_limited',
      'kill_failed',
    ].map(status => exitedSessionTransition(observation({ kind: 'exited', exitStatus: 0 }, status)));

    // Assert
    should(actual.every(item => item === undefined)).be.true();
  });

  it('should treat only statuses that claim a live agent as refutable', () => {
    // Act
    const actual = [undefined, 'running', 'awaiting_user', 'interrupted', 'stalled'].map(claimsRunningAgent);

    // Assert
    should(actual).deepEqual([false, true, true, true, false]);
  });
});
