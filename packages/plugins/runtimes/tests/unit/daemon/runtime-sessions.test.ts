import { describe, it } from 'bun:test';
import should from 'should';
import {
  renamedSessionConfig,
  type RuntimeSessionRecord,
  runningSessionsOn,
  sessionRunning,
  type SessionRuntimeRename,
} from '../../../daemon/lib/service/runtime-sessions.ts';
import { SESSION_STATUSES } from '../../../daemon/lib/service/foreign.ts';

const WRAPPER = '/fleet/bin/work';

const record = (over: Partial<RuntimeSessionRecord> & { id: string }): RuntimeSessionRecord => ({
  name: over.id,
  harness: 'claude',
  agent: 'work',
  status: 'running',
  ...over,
});

describe('sessionRunning', () => {
  it('should call a session over only when it ended, failed, stalled, stopped or is being reaped', () => {
    // Act
    const over = SESSION_STATUSES.filter(status => !sessionRunning(status));

    // Assert
    should(over).deepEqual(['kill_failed', 'completed', 'failed', 'stalled', 'stopped']);
  });

  it('should call every other session running', () => {
    // Assert
    should(sessionRunning('created')).be.true();
    should(sessionRunning('tool_running')).be.true();
    should(sessionRunning('rate_limited')).be.true();
  });
});

describe('runningSessionsOn', () => {
  it('should list running sessions by any spelling of the runtime, ordered by name then id', () => {
    // Arrange
    const records = [
      record({ id: 'c', name: 'zed' }),
      record({ id: 'b', name: 'amy', agent: 'old-name' }),
      record({ id: 'a', name: 'amy', agent: WRAPPER, harness: 'codex' }),
      record({ id: 'd', name: 'bob', agent: 'elsewhere', executable: WRAPPER }),
      record({ id: 'e', name: 'cat', agent: 'rt_1' }),
    ];

    // Act
    const actual = runningSessionsOn(records, {
      name: 'work',
      wrapper: WRAPPER,
      id: 'rt_1',
      formerNames: ['old-name'],
    });

    // Assert
    should(actual).deepEqual([
      { id: 'a', name: 'amy', harness: 'codex' },
      { id: 'b', name: 'amy', harness: 'claude-code' },
      { id: 'd', name: 'bob', harness: 'claude-code' },
      { id: 'e', name: 'cat', harness: 'claude-code' },
      { id: 'c', name: 'zed', harness: 'claude-code' },
    ]);
  });

  it('should leave out a finished session and one on another runtime', () => {
    // Arrange
    const records = [
      record({ id: 'done', status: 'completed' }),
      record({ id: 'reaped', status: 'kill_failed' }),
      record({ id: 'other', agent: 'other', executable: '/fleet/bin/other' }),
    ];

    // Act
    const actual = runningSessionsOn(records, { name: 'work', wrapper: WRAPPER });

    // Assert
    should(actual).deepEqual([]);
  });

  it('should not match an id the runtime does not have', () => {
    // Act
    const actual = runningSessionsOn([record({ id: 'a', agent: 'rt_1' })], { name: 'work', wrapper: WRAPPER });

    // Assert
    should(actual).deepEqual([]);
  });
});

describe('renamedSessionConfig', () => {
  const rename: SessionRuntimeRename = {
    from: 'work',
    to: 'play',
    fromWrapper: WRAPPER,
    toWrapper: '/fleet/bin/play',
  };

  it('should re-point a name and the wrapper at the head of the argv, keeping the rest', () => {
    // Act
    const actual = renamedSessionConfig({ agent: 'work', command: [WRAPPER, '--resume', 'x'], extra: 1 }, rename);

    // Assert
    should(actual).deepEqual({ agent: 'play', command: ['/fleet/bin/play', '--resume', 'x'], extra: 1 });
  });

  it('should turn a wrapper path into the new wrapper path', () => {
    // Act
    const actual = renamedSessionConfig({ agent: WRAPPER }, rename);

    // Assert
    should(actual).deepEqual({ agent: '/fleet/bin/play' });
  });

  it('should move only the argv when the agent names another runtime but the wrapper is the old one', () => {
    // Act
    const actual = renamedSessionConfig({ agent: 'else', command: [WRAPPER] }, rename);

    // Assert
    should(actual).deepEqual({ agent: 'else', command: ['/fleet/bin/play'] });
  });

  it('should return nothing for a session that names neither the old runtime nor its wrapper', () => {
    // Assert
    should(renamedSessionConfig({ agent: 'else', command: ['/fleet/bin/else'] }, rename)).be.undefined();
    should(renamedSessionConfig({ agent: 'else', command: 'not-an-argv' }, rename)).be.undefined();
  });

  it('should return nothing for a configuration that is not an object', () => {
    // Assert
    should(renamedSessionConfig(undefined, rename)).be.undefined();
    should(renamedSessionConfig(null, rename)).be.undefined();
    should(renamedSessionConfig('work', rename)).be.undefined();
    should(renamedSessionConfig([{ agent: 'work' }], rename)).be.undefined();
  });
});
