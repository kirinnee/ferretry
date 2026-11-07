import { describe, it } from 'bun:test';
import should from 'should';
import {
  type RuntimeSessionRecord,
  renamedSessionConfig,
  runningSessionsOn,
  sessionRunning,
  sessionRunsOn,
} from '../../../src/lib/fleet/runtime-sessions.ts';

const RUNTIME = {
  name: 'claude-glm-b',
  wrapper: '/fy/fleet/bin/claude-glm-b',
  id: '00000000-0000-4000-8000-00000000000b',
  formerNames: ['glm-b'],
};

const record = (overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord => ({
  id: 's-1',
  name: 'Fisher',
  harness: 'claude',
  agent: 'claude-glm-b',
  status: 'running',
  ...overrides,
});

const RENAME = {
  from: 'claude-glm-b',
  to: 'glm-work',
  fromWrapper: '/fy/fleet/bin/claude-glm-b',
  toWrapper: '/fy/fleet/bin/glm-work',
};

describe('sessionRunsOn', () => {
  it('should match a record by name, former name, id, wrapper path or launched executable', () => {
    // Act / Assert
    should(sessionRunsOn(record(), RUNTIME)).be.true();
    should(sessionRunsOn(record({ agent: 'glm-b' }), RUNTIME)).be.true();
    should(sessionRunsOn(record({ agent: RUNTIME.id }), RUNTIME)).be.true();
    should(sessionRunsOn(record({ agent: RUNTIME.wrapper }), RUNTIME)).be.true();
    should(sessionRunsOn(record({ agent: 'other', executable: RUNTIME.wrapper }), RUNTIME)).be.true();
  });

  it('should not match another runtime, nor a runtime with no id or former names by those', () => {
    // Act / Assert
    should(sessionRunsOn(record({ agent: 'other', executable: '/fy/fleet/bin/other' }), RUNTIME)).be.false();
    should(sessionRunsOn(record({ agent: 'glm-b' }), { name: RUNTIME.name, wrapper: RUNTIME.wrapper })).be.false();
  });
});

describe('runningSessionsOn', () => {
  it('should list only the running sessions on the runtime, by name then id', () => {
    // Arrange
    const records = [
      record({ id: 's-3', name: 'Otter' }),
      record({ id: 's-2', name: 'Fisher', status: 'awaiting_user' }),
      record({ id: 's-1', name: 'Fisher', status: 'thinking' }),
      record({ id: 's-4', name: 'Done', status: 'completed' }),
      record({ id: 's-5', name: 'Elsewhere', agent: 'other' }),
    ];

    // Act
    const running = runningSessionsOn(records, RUNTIME);

    // Assert
    should(running).deepEqual([
      { id: 's-1', name: 'Fisher', harness: 'claude' },
      { id: 's-2', name: 'Fisher', harness: 'claude' },
      { id: 's-3', name: 'Otter', harness: 'claude' },
    ]);
  });

  it('should call a stopped, failed or reaped session not running', () => {
    // Act / Assert
    should(
      ['stopped', 'failed', 'completed', 'stalled', 'kill_failed'].map(status => sessionRunning(status as never)),
    ).deepEqual([false, false, false, false, false]);
    should(sessionRunning('rate_limited')).be.true();
  });
});

describe('renamedSessionConfig', () => {
  it('should re-point the name and the launched wrapper, keeping the rest of the argv and record', () => {
    // Arrange
    const current = { id: 's-1', agent: 'claude-glm-b', command: [RENAME.fromWrapper, '--resume', 'abc'], turn: 4 };

    // Act
    const next = renamedSessionConfig(current, RENAME);

    // Assert
    should(next).deepEqual({ id: 's-1', agent: 'glm-work', command: [RENAME.toWrapper, '--resume', 'abc'], turn: 4 });
  });

  it('should keep an agent spelled as a wrapper path a wrapper path', () => {
    // Act
    const next = renamedSessionConfig({ agent: RENAME.fromWrapper }, RENAME);

    // Assert
    should(next).deepEqual({ agent: RENAME.toWrapper });
  });

  it('should move only the argv when the record names the runtime there alone', () => {
    // Act
    const next = renamedSessionConfig({ agent: 'migrated-away', command: [RENAME.fromWrapper] }, RENAME);

    // Assert
    should(next).deepEqual({ agent: 'migrated-away', command: [RENAME.toWrapper] });
  });

  it('should leave a record on another runtime, or one that is not a document, alone', () => {
    // Act / Assert
    should(renamedSessionConfig({ agent: 'other', command: ['/fy/fleet/bin/other'] }, RENAME)).be.undefined();
    should(renamedSessionConfig({ agent: 'other', command: 'not-an-argv' }, RENAME)).be.undefined();
    should(renamedSessionConfig(null, RENAME)).be.undefined();
    should(renamedSessionConfig(['claude-glm-b'], RENAME)).be.undefined();
  });
});
