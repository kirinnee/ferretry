import { describe, it } from 'bun:test';
import should from 'should';
import { createSessionRecord, transitionSessionRecord } from '../../../../src/lib/session/lifecycle/index.ts';

const NOW = '2026-07-31T10:00:00.000Z';

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    agent: '/opt/fleet/agent',
    cwd: '/workspace/project',
    mode: 'auto' as const,
    prompt: 'Implement the lifecycle service',
    ...overrides,
  };
}

describe('session lifecycle policy', () => {
  it('should construct an immutable created record before a process launch', () => {
    // Arrange
    const input = request({
      name: '  Lifecycle  ',
      command: ['/opt/fleet/agent', '--model', 'fast'],
      parent: 'parent-1',
    });

    // Act
    const result = createSessionRecord(input, NOW);

    // Assert
    should(result.record).deepEqual({
      config: {
        id: 'session-1',
        name: 'Lifecycle',
        agent: '/opt/fleet/agent',
        command: ['/opt/fleet/agent', '--model', 'fast'],
        cwd: '/workspace/project',
        mode: 'auto',
        prompt: 'Implement the lifecycle service',
        parent: 'parent-1',
        createdAt: NOW,
        updatedAt: NOW,
        tmuxSession: 'fy-session-1',
      },
      state: { id: 'session-1', status: 'created' },
    });
    should(result.event).deepEqual({
      type: 'session.created',
      data: { agent: '/opt/fleet/agent', mode: 'auto', cwd: '/workspace/project' },
    });
  });

  it('should derive names and allow an interactive session without an opening prompt', () => {
    // Arrange + Act
    const named = createSessionRecord(request({ name: undefined }), NOW);
    const interactive = createSessionRecord(request({ mode: 'interactive', prompt: '   ', name: undefined }), NOW);

    // Assert
    should(named.record.config.name).equal('Implement-the-lifecycle-service');
    should(interactive.record.config).containDeep({ name: 'interactive', mode: 'interactive' });
    should(interactive.record.config).not.have.property('prompt');
  });

  it('should reject malformed creation inputs before persistence or process work', () => {
    // Arrange + Act + Assert
    should(() => createSessionRecord(request({ id: '../escape' }), NOW)).throw(/path-safe/u);
    should(() => createSessionRecord(request({ agent: ' ' }), NOW)).throw('agent is required');
    should(() => createSessionRecord(request({ cwd: ' ' }), NOW)).throw('cwd is required');
    should(() => createSessionRecord(request({ prompt: ' ' }), NOW)).throw('prompt is required for auto sessions');
    should(() => createSessionRecord(request({ command: [''] }), NOW)).throw('command item is required');
    should(() => createSessionRecord(request({ parent: '../escape' }), NOW)).throw(/path-safe/u);
  });

  it('should allow only forward lifecycle transitions and timestamp terminal records', () => {
    // Arrange
    const created = createSessionRecord(request(), NOW).record;

    // Act
    const starting = transitionSessionRecord(created, 'starting', '2026-07-31T10:01:00.000Z');
    const running = transitionSessionRecord(starting.record, 'running', '2026-07-31T10:02:00.000Z');
    const stopped = transitionSessionRecord(running.record, 'stopped', '2026-07-31T10:03:00.000Z', 'completed');

    // Assert
    should(starting.record.state).deepEqual({
      id: 'session-1',
      status: 'starting',
      startedAt: '2026-07-31T10:01:00.000Z',
    });
    should(running.record.state.startedAt).equal('2026-07-31T10:01:00.000Z');
    should(stopped.record.state).deepEqual({
      id: 'session-1',
      status: 'stopped',
      startedAt: '2026-07-31T10:01:00.000Z',
      finishedAt: '2026-07-31T10:03:00.000Z',
      reason: 'completed',
    });
    should(stopped.event).deepEqual({ type: 'session.stopped', data: { reason: 'completed' } });
    should(() => transitionSessionRecord(stopped.record, 'running', NOW)).throw(/cannot transition/u);
  });

  it('should support an early stop and a launch failure without inventing a running state', () => {
    // Arrange
    const created = createSessionRecord(request(), NOW).record;
    const starting = transitionSessionRecord(created, 'starting', '2026-07-31T10:01:00.000Z').record;

    // Act
    const earlyStop = transitionSessionRecord(created, 'stopped', '2026-07-31T10:01:00.000Z');
    const failed = transitionSessionRecord(starting, 'failed', '2026-07-31T10:02:00.000Z', 'tmux unavailable');

    // Assert
    should(earlyStop.event).deepEqual({ type: 'session.stopped', data: {} });
    should(failed.record.state).containDeep({ status: 'failed', finishedAt: '2026-07-31T10:02:00.000Z' });
    should(failed.event).deepEqual({ type: 'session.failed', data: { reason: 'tmux unavailable' } });
  });
});
