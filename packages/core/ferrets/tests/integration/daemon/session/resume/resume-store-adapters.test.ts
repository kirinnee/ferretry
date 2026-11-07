import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileResumeTurnStore } from '../../../../../daemon/adapters/session/resume/file-resume-turn-store.ts';
import { StorageResumeRepository } from '../../../../../daemon/adapters/session/resume/storage-resume-repository.ts';
import type { SessionLaunchInstructions } from '../../../../../daemon/lib/protocol/session.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { memoryStorage, sessionConfig, sessionState } from '../../../../support/daemon/storage.ts';
import { FerretStateFile } from '../../../../../contract/index.ts';

const homes = new Set<string>();
const ID = parseSessionId('session-1');

async function temporaryDirectory(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-resume-test-'));
  homes.add(home);
  return home;
}

/** A configuration the declared schema accepts, as the start wrote it. */
function config(id = 'session-1', overrides: Record<string, unknown> = {}) {
  return sessionConfig(id, { name: 'Revive me', cwd: '/workspace/project', mode: 'auto', turn: 3, ...overrides });
}

/** A pending question the declared schema accepts. */
const QUESTION = { toolUseId: 'tool-1', questions: [{ question: 'Which branch?' }] };

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('resume turn store', () => {
  it('should write a numbered turn document atomically inside the session directory', async () => {
    // Arrange
    const home = await temporaryDirectory();
    const store = new FileResumeTurnStore(() => join(home, 'sessions', 'session-1'));

    // Act
    const file = await store.writeTurn(ID, 4, 'Continue the assigned task.\n');

    // Assert
    should(file).endWith('turns/turn-004.md');
    should(await readFile(file, 'utf8')).equal('Continue the assigned task.\n');
    should((await stat(file)).mode & 0o777).equal(0o600);
  });

  it('should remove stale completion markers, and tolerate ones that were never written', async () => {
    // Arrange — a `done` marker from the previous turn would end the new turn the moment it starts.
    const home = await temporaryDirectory();
    const directory = join(home, 'sessions', 'session-1');
    const store = new FileResumeTurnStore(() => directory);
    await store.writeTurn(ID, 4, 'anything');
    await writeFile(join(directory, 'done.marker'), 'done', 'utf8');

    // Act
    await store.clearMarkers(ID);
    await store.clearMarkers(ID);

    // Assert
    await should(stat(join(directory, 'done.marker'))).be.rejected();
  });
});

describe('storage resume repository', () => {
  it('should read a durable session as a resume target', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(
      ID,
      config('session-1', {
        label: 'my-batch',
        retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
      }),
    );
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped', turn: 3, retryAttempt: 1 }));

    // Act
    const actual = await new StorageResumeRepository(opened.storage).read(ID);

    // Assert
    should(actual).deepEqual({
      id: ID,
      status: 'stopped',
      mode: 'auto',
      cwd: '/workspace/project',
      label: 'my-batch',
      turn: 3,
      retryAttempt: 1,
      transientRetryBudget: 2,
    });
  });

  it('should take the turn from the document that actually moves', async () => {
    // Both documents carry a turn and only the STATE's is ever updated: a revive records the turn it
    // handed over through `transition({ turn })`, and nothing rewrites the configuration's copy.
    // Reading the configuration first froze every session at the turn it was created on, so the
    // SECOND revive planned the same number again and overwrote the first revive's assignment.
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped', turn: 7 }));

    // Act
    const actual = await new StorageResumeRepository(opened.storage).read(ID);

    // Assert
    should(actual).have.property('turn', 7);
  });

  it('should report nothing for a session that was never written', async () => {
    // Arrange
    const opened = await memoryStorage();

    // Act
    const actual = await new StorageResumeRepository(opened.storage).read(ID);

    // Assert
    should(actual).be.undefined();
  });

  it('should refuse to guess at a record whose status or mode will not parse', async () => {
    // Arrange — resume replaces terminals, so acting on a record it could not read is the one
    // mistake that costs an operator a live agent. A blank working directory passes the stored schema
    // and is still no place to relaunch in; a status the protocol does not define is refused by the store.
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config('session-1', { cwd: '   ' }));
    await opened.storage.writeState(ID, sessionState('session-1'));
    const other = parseSessionId('session-2');
    await opened.storage.writeConfig(other, config('session-2'));
    await opened.storage.writeState(other, sessionState('session-2'));
    opened.folder.plant(FerretStateFile, JSON.stringify(sessionState('session-2', { status: 'transcending' })), other);
    const repository = new StorageResumeRepository(opened.storage);

    // Act
    const blank = await repository.read(ID);

    // Assert — no target is guessed at either way.
    should(blank).be.undefined();
    await should(repository.read(other)).be.rejected();
  });

  it('should carry a pending question through, and none for a cleared one', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(
      ID,
      sessionState('session-1', { pendingQuestion: QUESTION, needsHumanKind: 'picker_cleanup' }),
    );
    const other = parseSessionId('session-2');
    await opened.storage.writeConfig(other, config('session-2'));
    await opened.storage.writeState(other, sessionState('session-2', { pendingQuestion: null }));

    // Act
    const repository = new StorageResumeRepository(opened.storage);
    const actual = [await repository.read(ID), await repository.read(other)];

    // Assert
    should(actual[0]?.pendingQuestion).deepEqual({ toolUseId: 'tool-1' });
    should(actual[0]?.needsHumanKind).equal('picker_cleanup');
    should(actual[1]?.pendingQuestion).be.undefined();
  });

  it('should list every readable session and silently skip the unreadable ones', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, sessionState('session-1'));
    const broken = parseSessionId('session-2');
    await opened.storage.writeConfig(broken, config('session-2'));
    await opened.storage.writeState(broken, sessionState('session-2'));
    opened.folder.plant(FerretStateFile, JSON.stringify(sessionState('session-2', { status: 'nonsense' })), broken);

    // Act
    const actual = await new StorageResumeRepository(opened.storage).list();

    // Assert
    should(actual.map(item => item.id)).deepEqual(['session-1']);
  });

  it('should write the state before it journals the event that describes it', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(
      ID,
      sessionState('session-1', { status: 'stopped', needsHumanKind: 'picker_cleanup' }),
    );

    // Act
    const actual = await new StorageResumeRepository(opened.storage).transition(ID, {
      event: 'session.resumed',
      status: 'running',
      retryAttempt: 0,
      reason: 'revived by an operator',
      clearNeedsHuman: true,
    });

    // Assert
    should(actual.status).equal('running');
    should(actual.needsHumanKind).be.undefined();
    should(actual.retryAttempt).equal(0);
    const state = (await opened.storage.readState(ID)) as Record<string, unknown>;
    should(state.reason).equal('revived by an operator');
  });

  it('should replace the launch record on a relaunch and keep it through a transition that launched nothing', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    const before: SessionLaunchInstructions = {
      sections: [{ id: 'tools', chars: 10 }],
      mode: 'auto',
      questions: false,
    };
    const after: SessionLaunchInstructions = {
      sections: [
        { id: 'tools', chars: 10 },
        { id: 'pack', chars: 20 },
      ],
      mode: 'auto',
      questions: false,
    };
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped', launchInstructions: before }));
    const repository = new StorageResumeRepository(opened.storage);

    // Act
    await repository.transition(ID, { event: 'session.resuming', status: 'starting' });
    const kept = (await opened.storage.readState(ID)) as Record<string, unknown>;
    await repository.transition(ID, { event: 'session.resumed', status: 'running', launchInstructions: after });
    const replaced = (await opened.storage.readState(ID)) as Record<string, unknown>;

    // Assert
    should(kept.launchInstructions).deepEqual(before);
    should(replaced.launchInstructions).deepEqual(after);
  });

  it('should clear a pending question on the transition that abandons it', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config());
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped', pendingQuestion: QUESTION }));

    // Act
    const actual = await new StorageResumeRepository(opened.storage).transition(ID, {
      event: 'session.question_cancelled',
      clearPendingQuestion: true,
      data: { abandoned: true },
    });

    // Assert
    should(actual.pendingQuestion).be.undefined();
  });

  it('should refuse to report success for a transition it can no longer read back', async () => {
    // Arrange
    const opened = await memoryStorage();
    await opened.storage.writeConfig(ID, config('session-1', { cwd: '   ' }));
    await opened.storage.writeState(ID, sessionState('session-1', { status: 'stopped' }));

    // Act / Assert
    await should(
      new StorageResumeRepository(opened.storage).transition(ID, { event: 'session.resumed', status: 'running' }),
    ).be.rejectedWith(/unreadable after a resume transition/u);
  });
});
