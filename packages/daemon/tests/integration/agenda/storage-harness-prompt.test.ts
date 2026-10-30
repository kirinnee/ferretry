import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import should from 'should';
import { FileAgendaLedgerRepository } from '../../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import {
  HARNESS_ANSWER_FAILED_EVENT,
  StorageHarnessPromptJournal,
  StorageHarnessPromptStates,
  StorageHarnessQuestionAnswerer,
} from '../../../src/adapters/agenda/storage-harness-prompt.ts';
import { StorageSessionAgendaState } from '../../../src/adapters/agenda/storage-session-agenda-state.ts';
import {
  BunSqliteIndexFactory,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../src/adapters/index.ts';
import {
  AgendaChangeFanout,
  AgendaService,
  HarnessPromptAgenda,
  HarnessPromptAnswerDelivery,
  SessionAgendaProjection,
} from '../../../src/lib/agenda/index.ts';
import { parseSessionId } from '../../../src/lib/index.ts';

/**
 * A harness parked on its own question form, as a real Agenda item: raised from the state documents
 * a real storage writes, kept in the real board file, answered through the answer subsystem's port, and
 * cleared when the form goes. Runs against a temp `FY_HOME`; no daemon, no port, no tmux.
 */

const homes = new Set<string>();
const storages = new Set<{ close(): Promise<void> | void }>();
const NOW = '2026-10-28T10:00:00.000Z';
const ID = parseSessionId('session-1');

const QUESTION: PendingQuestion = {
  toolUseId: 'toolu_1',
  questions: [{ question: 'Which region first?', options: [{ label: 'eu' }, { label: 'us' }] }],
};

async function open(outcome: 'answer' | 'reject') {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-harness-prompt-'));
  homes.add(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  );
  const { storage } = await factory.open();
  storages.add(storage);
  await storage.writeConfig(ID, {
    id: 'session-1',
    name: 'Harness prompt',
    agent: '/opt/fleet/bin/claude',
    command: ['/opt/fleet/bin/claude'],
    cwd: '/workspace/project',
    mode: 'auto',
    turn: 1,
    tmuxSession: 'fy-session-1',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const boards = new FileAgendaLedgerRepository(sessionId => join(home, 'boards', sessionId));
  const driven: Array<{ toolUseId: string; answers: readonly StructuredQuestionAnswer[]; requestId: string }> = [];
  // The answer subsystem's port: on success it clears the form exactly as the real one does.
  const answers = {
    answer: async (
      sessionId: string,
      request: { toolUseId: string; answers?: readonly StructuredQuestionAnswer[] | undefined; requestId: string },
    ) => {
      driven.push({ toolUseId: request.toolUseId, answers: request.answers ?? [], requestId: request.requestId });
      if (outcome === 'reject') throw new Error("Couldn't answer automatically.");
      await storage.updateState(parseSessionId(sessionId), current => {
        const next: Record<string, unknown> = { ...(current as Record<string, unknown>), status: 'running' };
        delete next.pendingQuestion;
        return next as typeof current;
      });
      return undefined as never;
    },
  };
  let service: AgendaService | undefined;
  const delivery = new HarnessPromptAnswerDelivery(
    new StorageHarnessQuestionAnswerer(storage, answers),
    new StorageHarnessPromptJournal(storage),
    {
      raise: async (...parameters) => {
        if (service === undefined) throw new Error('the board is not built yet');
        return await service.raise(...parameters);
      },
    },
  );
  service = new AgendaService(
    boards,
    { now: () => NOW },
    { has: async sessionId => sessionId === 'session-1' },
    { raised: async () => undefined },
    // As fyd wires it: the projection keeps `state.agenda` true to the board, which is what a restarted
    // daemon's reconcile reads to know a session still has an item to clear.
    new AgendaChangeFanout([
      new SessionAgendaProjection(boards, new StorageSessionAgendaState(storage), new KeyedSerialExecutor(), () => NOW),
      delivery,
    ]),
  );
  const harness = new HarnessPromptAgenda(service, new KeyedSerialExecutor(), new StorageHarnessPromptStates(storage));
  const settling: Promise<void>[] = [];
  const unsubscribe = storage.subscribeStates(
    (sessionId, state) => void settling.push(harness.stateWritten(sessionId, state)),
  );
  const settled = async () => {
    while (settling.length > 0) await Promise.all(settling.splice(0));
  };
  /**
   * The daemon goes DOWN: its live subscription stops hearing state writes, after what it already heard
   * has settled. A write made after this is one no running daemon saw, which is what a restart reconciles.
   */
  const down = async () => {
    await settled();
    unsubscribe();
  };
  return { home, storage, boards, service, harness, driven, settled, down };
}

afterEach(async () => {
  for (const storage of storages) await storage.close();
  storages.clear();
  await Promise.all([...homes].map(async home => await rm(home, { recursive: true, force: true })));
  homes.clear();
});

describe('harness prompts on the board', () => {
  it('should raise the parked question into the board file, type the answer in, and clear it', async () => {
    // Arrange
    const { storage, boards, service, driven, settled } = await open('answer');

    // Act
    await storage.writeState(ID, { id: 'session-1', status: 'awaiting_question', turn: 1, pendingQuestion: QUESTION });
    await settled();
    const file = JSON.parse(await readFile(boards.file('session-1'), 'utf8'));
    await service.answer('session-1', 'A1', { kind: 'multiple-choice', choice: 'eu' }, { kind: 'human' });
    await settled();
    const after = await service.list('session-1');

    // Assert
    should(
      file.entries.map((entry: { item: { source: string; sourceRef: string } }) => entry.item.sourceRef),
    ).deepEqual(['toolu_1']);
    should(file.entries[0].origin).deepEqual({ kind: 'daemon', cause: 'harness-prompt' });
    should(driven).deepEqual([
      { toolUseId: 'toolu_1', answers: [{ kind: 'selection', labels: ['eu'] }], requestId: 'attention:session-1:A1' },
    ]);
    should(after.ok && after.value.count).equal(0);
    should(after.ok && after.value.resolved.map(item => item.resolvedBy)).deepEqual(['human']);
  });

  it('should journal an answer that did not reach the form and raise the question again', async () => {
    // Arrange
    const { storage, service, driven, settled } = await open('reject');
    await storage.writeState(ID, { id: 'session-1', status: 'awaiting_question', turn: 1, pendingQuestion: QUESTION });
    await settled();

    // Act
    await service.answer('session-1', 'A1', { kind: 'multiple-choice', choice: 'us' }, { kind: 'human' });
    const events = (await storage.replay(ID)).events;
    const listed = await service.list('session-1');

    // Assert
    should(driven.length).equal(1);
    should(events.filter(event => event.type === HARNESS_ANSWER_FAILED_EVENT).map(event => event.data)).deepEqual([
      { id: 'A1', toolUseId: 'toolu_1', reason: "Couldn't answer automatically." },
    ]);
    should(listed.ok && listed.value.items.map(item => [item.id, item.sourceRef])).deepEqual([['A2', 'toolu_1']]);
  });

  it('should keep one item across a restart and clear it once the session ended while down', async () => {
    // Arrange
    const first = await open('answer');
    await first.storage.writeState(ID, {
      id: 'session-1',
      status: 'awaiting_question',
      turn: 1,
      pendingQuestion: QUESTION,
    });
    await first.down();
    const states = new StorageHarnessPromptStates(first.storage);

    // Act
    // The first daemon is down, so nothing but the restarted one's reconcile reads these writes. Its
    // subscription used to stay live here and race the reconcile on the same board file, and the fixture
    // left out fyd's agenda projection, so the restart could only ever clear the item through that race.
    const restarted = new HarnessPromptAgenda(first.service, new KeyedSerialExecutor(), states);
    await restarted.reconcile(['session-1', 'not a session']);
    const kept = await first.service.list('session-1');
    await first.storage.updateState(
      ID,
      current => ({ ...(current as Record<string, unknown>), status: 'stopped' }) as typeof current,
    );
    const again = new HarnessPromptAgenda(first.service, new KeyedSerialExecutor(), states);
    await again.reconcile(['session-1']);
    const cleared = await first.service.list('session-1');

    // Assert
    should(kept.ok && kept.value.items.map(item => item.id)).deepEqual(['A1']);
    should(cleared.ok && cleared.value.count).equal(0);
    should(cleared.ok && cleared.value.resolved.map(item => item.resolvedBy)).deepEqual(['daemon']);
  });

  it('should read no question and journal nothing for an id that is not a session', async () => {
    // Arrange
    const { storage } = await open('answer');

    // Act
    const pending = await new StorageHarnessQuestionAnswerer(storage, {
      answer: async () => undefined as never,
    }).pending('../escape');
    await new StorageHarnessPromptJournal(storage).answerFailed('../escape', { id: 'A1', toolUseId: 't', reason: 'r' });

    // Assert
    should(pending).be.undefined();
  });
});
