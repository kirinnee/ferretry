import { describe, it } from 'bun:test';
import { SessionConfigSchema, SessionStateSchema } from '@ferretry/protocol';
import should from 'should';
import {
  StorageTerminalOwnerDirectory,
  type TerminalOwnerStorage,
} from '../../../src/adapters/terminal/owner-directory.ts';

const AT = '2026-01-01T00:00:00.000Z';

function config(id: string, names: { name: string; teammate?: string }): unknown {
  return SessionConfigSchema.parse({
    id,
    incarnation: `${id}-1`,
    runtimeGeneration: 1,
    ...names,
    agent: 'claude-auto',
    harness: 'claude',
    modelHint: 'opus',
    mode: 'auto',
    remoteControl: false,
    harnessFlags: [],
    cwd: '/home/dev/repo',
    createdAt: AT,
    updatedAt: AT,
    turn: 1,
    intervalSeconds: 30,
    timeoutSeconds: 0,
    nudgeAfterSeconds: 0,
    killAfterSeconds: 0,
    directSendMaxChars: 4_096,
    resumeMenuChoice: 'full',
    maxSnapshots: 10,
    retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
  });
}

function state(id: string, status: string): unknown {
  return SessionStateSchema.parse({ id, status, turn: 1, lastActivityAt: AT });
}

interface Held {
  readonly config?: unknown;
  readonly state?: unknown;
  readonly configFails?: boolean;
  readonly stateFails?: boolean;
}

/** A session store holding exactly the sessions given. */
function storage(held: Record<string, Held>): TerminalOwnerStorage {
  return {
    findSession: id => (id in held ? { id } : undefined),
    readConfig: async id => {
      if (held[id]?.configFails === true) throw new Error('config unreadable');
      return held[id]?.config;
    },
    readState: async id => {
      if (held[id]?.stateFails === true) throw new Error('state unreadable');
      return held[id]?.state;
    },
  };
}

describe('StorageTerminalOwnerDirectory', () => {
  it('should place a stopped session as finished, labelled by its callsign', async () => {
    // Arrange
    const sut = new StorageTerminalOwnerDirectory(
      storage({
        's-1': { config: config('s-1', { name: 'Fix', teammate: 'fitzgerald' }), state: state('s-1', 'stopped') },
      }),
    );

    // Act
    const standing = await sut.standing('s-1');

    // Assert
    should(standing).deepEqual({ standing: 'finished', status: 'stopped', label: 'fitzgerald' });
  });

  it('should label a session by its name when it has no callsign, and call a running one live', async () => {
    // Arrange
    const sut = new StorageTerminalOwnerDirectory(
      storage({ 's-1': { config: config('s-1', { name: 'Fix the bug' }), state: state('s-1', 'running') } }),
    );

    // Act
    const standing = await sut.standing('s-1');

    // Assert
    should(standing).deepEqual({ standing: 'live', status: 'running', label: 'Fix the bug' });
  });

  it('should call a session the store does not hold gone, and one that is not even an id gone too', async () => {
    // Arrange
    const sut = new StorageTerminalOwnerDirectory(storage({}));

    // Act
    const missing = await sut.standing('s-9');
    const malformed = await sut.standing('NOT AN ID');

    // Assert
    should(missing).deepEqual({ standing: 'gone', status: 'removed', label: 's-9' });
    should(malformed).deepEqual({ standing: 'gone', status: 'removed', label: 'NOT AN ID' });
  });

  it('should never close a shell on a guess: unreadable or unparsable state is live and unknown', async () => {
    // Arrange
    const good = config('s-1', { name: 'Fix', teammate: 'fitzgerald' });
    const sut = new StorageTerminalOwnerDirectory(
      storage({
        'bad-state': { config: good, state: { status: 42 } },
        'throws-state': { config: good, stateFails: true },
      }),
    );

    // Act
    const badState = await sut.standing('bad-state');
    const throwsState = await sut.standing('throws-state');

    // Assert
    should(badState).deepEqual({ standing: 'live', status: 'unknown', label: 'fitzgerald' });
    should(throwsState).deepEqual({ standing: 'live', status: 'unknown', label: 'fitzgerald' });
  });

  it('should fall back to the id as the label when the config cannot be read, keeping the real standing', async () => {
    // Arrange
    const sut = new StorageTerminalOwnerDirectory(
      storage({
        'throws-config': { configFails: true, state: state('throws-config', 'completed') },
        'bad-config': { config: { nonsense: true }, state: state('bad-config', 'running') },
      }),
    );

    // Act
    const throwsConfig = await sut.standing('throws-config');
    const badConfig = await sut.standing('bad-config');

    // Assert
    should(throwsConfig).deepEqual({ standing: 'finished', status: 'completed', label: 'throws-config' });
    should(badConfig).deepEqual({ standing: 'live', status: 'running', label: 'bad-config' });
  });
});
