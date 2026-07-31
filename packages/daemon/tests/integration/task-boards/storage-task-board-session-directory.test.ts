import { describe, it } from 'bun:test';
import should from 'should';
import { StorageTaskBoardSessionDirectory } from '../../../src/adapters/task-boards/storage-task-board-session-directory.ts';

const AT = '2026-07-31T09:00:00.000Z';
const HASH = 'a'.repeat(64);

/** The configuration document a real session directory holds: a protocol envelope with the
 *  lifecycle's own fields merged over it, exactly as `StorageSessionLifecycleRepository` writes it. */
function configDocument(id: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id,
    incarnation: `${id}-1`,
    runtimeGeneration: 1,
    name: 'Wire Subsystems',
    boardAccess: 'none',
    agent: 'claude-auto',
    harness: 'claude',
    modelHint: 'opus',
    mode: 'interactive',
    remoteControl: false,
    harnessFlags: [],
    cwd: '/work/ferretry',
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
    // The lifecycle's own fields, which the merged document carries beside the protocol's.
    command: ['/usr/bin/claude-auto'],
    tmuxSession: `fy-${id}`,
    sessionCapabilityHash: HASH,
    ...overrides,
  };
}

function directory(
  documents: Readonly<Record<string, { readonly config: unknown; readonly state: unknown }>>,
): StorageTaskBoardSessionDirectory {
  return new StorageTaskBoardSessionDirectory({
    sessionIds: () => Object.keys(documents),
    readConfig: async id => documents[id]?.config,
    readState: async id => documents[id]?.state,
  });
}

describe('StorageTaskBoardSessionDirectory', () => {
  it('should project the fields every board authorization decision is keyed on', async () => {
    // Arrange
    const source = directory({
      root: {
        config: configDocument('root', { teammate: 'loge' }),
        state: { id: 'root', status: 'running', turn: 1, lastActivityAt: AT },
      },
    });

    // Act
    const sessions = await source.snapshot();

    // Assert
    should(sessions).eql([
      {
        id: 'root',
        incarnation: 'root-1',
        runtimeGeneration: 1,
        parentSessionId: null,
        mode: 'interactive',
        active: true,
        name: 'Wire Subsystems',
        teammate: 'loge',
        sessionCapabilityHash: HASH,
      },
    ]);
  });

  it('should report a parent so lineage and descendant checks can be made', async () => {
    // Arrange
    const source = directory({
      child: {
        config: configDocument('child', { parent: 'root', mode: 'auto' }),
        state: { id: 'child', status: 'thinking', turn: 2 },
      },
    });

    // Act
    const sessions = await source.snapshot();

    // Assert
    should(sessions[0]).have.property('parentSessionId', 'root');
    should(sessions[0]).have.property('mode', 'auto');
  });

  it('should omit a session that holds no credential, because no grant could ever bind to it', async () => {
    // Arrange — a session started before the per-session credential existed.
    const source = directory({
      legacy: {
        config: configDocument('legacy', { sessionCapabilityHash: undefined }),
        state: { id: 'legacy', status: 'running', turn: 1 },
      },
    });

    // Act
    const sessions = await source.snapshot();

    // Assert
    should(sessions).be.empty();
  });

  it('should omit a session whose configuration document does not satisfy the protocol', async () => {
    // Arrange — an incarnation is a term in `isCapabilityBoundToSession`; guessing one would
    // manufacture a match against a capability minted for a different incarnation.
    const source = directory({
      damaged: {
        config: configDocument('damaged', { incarnation: '' }),
        state: { id: 'damaged', status: 'running', turn: 1 },
      },
    });

    // Act
    const sessions = await source.snapshot();

    // Assert
    should(sessions).be.empty();
  });

  it('should omit a session whose credential hash is not a hash', async () => {
    // Arrange
    const source = directory({
      damaged: {
        config: configDocument('damaged', { sessionCapabilityHash: 'not-a-hash' }),
        state: { id: 'damaged', status: 'running', turn: 1 },
      },
    });

    // Act & Assert
    should(await source.snapshot()).be.empty();
  });

  it('should report a session in a status it never leaves as inactive, so its grants stop authorizing', async () => {
    // Arrange
    const source = directory({
      finished: {
        config: configDocument('finished'),
        state: { id: 'finished', status: 'completed', turn: 4 },
      },
      halted: {
        config: configDocument('halted'),
        state: { id: 'halted', status: 'stalled', turn: 4 },
      },
    });

    // Act
    const sessions = await source.snapshot();

    // Assert
    should(sessions.map(session => session.active)).eql([false, false]);
  });

  it('should report a session whose state document is unreadable as inactive rather than assume it is live', async () => {
    // Arrange
    const source = directory({
      opaque: { config: configDocument('opaque'), state: { nothing: 'useful' } },
    });

    // Act
    const sessions = await source.snapshot();

    // Assert — "I cannot tell whether this session is alive" answers no, which denies rather than grants.
    should(sessions).have.length(1);
    should(sessions[0]).have.property('active', false);
  });

  it('should answer with the empty fleet when the daemon holds no sessions', async () => {
    // Act & Assert
    should(await directory({}).snapshot()).be.empty();
  });
});
