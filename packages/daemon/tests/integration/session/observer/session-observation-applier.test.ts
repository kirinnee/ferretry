/**
 * THE ONE WRITER of what a session observer derives, over real storage.
 *
 * One session's patches are applied one at a time in the order they were handed in (#689: a question
 * patch handed in before a turn patch lands first), receipts are appended even when nothing else
 * changes, and a question patch is re-decided against the document it holds the lock on.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionState } from '@ferretry/protocol';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SessionObservationApplier,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import {
  type AnswerOperationRecord,
  parseSessionId,
  type QuestionPatch,
  stepQuestion,
  type TranscriptEvent,
} from '../../../../src/lib/index.ts';

const NOW = '2026-10-22T08:00:00.000Z';
const ID = parseSessionId('applied-1');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function openStorage(): Promise<DaemonStorage> {
  const home = await mkdtemp(join(tmpdir(), 'fy-observation-applier-'));
  const opened = await new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(NOW)),
    () => new KeyedSerialExecutor(),
  ).open();
  cleanups.push(async () => {
    await opened.storage.close();
    await rm(home, { recursive: true, force: true });
  });
  return opened.storage;
}

const question: TranscriptEvent = {
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  timestamp: NOW,
  call: {
    id: 'tool-1',
    name: 'AskUserQuestion',
    input: {},
    questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }], multiple: false }],
  },
};
const released: TranscriptEvent = {
  kind: 'tool-result',
  harness: 'claude',
  role: 'tool',
  result: { callId: 'tool-1', content: 'Yes', isError: false },
};
const accepted: AnswerOperationRecord = {
  requestId: 'request-1',
  toolUseId: 'tool-1',
  fingerprint: 'fingerprint-1',
  acceptedAt: NOW,
  outcome: 'accepted',
} as AnswerOperationRecord;

const patchFor = (
  state: Partial<SessionState>,
  events: readonly TranscriptEvent[],
  answers = new Map(),
): QuestionPatch => {
  const patch = stepQuestion({
    state: { id: ID, status: 'running', turn: 1, ...state } as SessionState,
    events,
    answers,
  });
  if (patch === undefined) throw new Error('the look implied nothing');
  return patch;
};

describe('SessionObservationApplier', () => {
  it('should apply one session’s patches in the order handed in: the question before the turn', async () => {
    // Arrange
    const storage = await openStorage();
    await storage.writeState(ID, { id: ID, status: 'running', turn: 1 });
    const appended: AnswerOperationRecord[] = [];
    const subject = new SessionObservationApplier(
      storage,
      { append: async (_id, record) => void appended.push(record) },
      new KeyedSerialExecutor(),
    );

    // Act — both handed in at once; the turn's compare-and-set would refuse if it ran first, because the
    // question flips the status the turn decision was read against.
    const [asked, turned] = await Promise.all([
      subject.apply(ID, patchFor({}, [question]), NOW),
      subject.apply(ID, { kind: 'turn', change: { from: undefined, to: 'needs-input' } }, NOW),
    ]);

    // Assert
    should([asked, turned]).deepEqual([true, true]);
    const state = (await storage.readState(ID)) as Record<string, unknown>;
    should(state.status).equal('awaiting_question');
    should(state.turnState).equal('needs-input');
    should((await storage.replay(ID)).events.map(event => event.type)).deepEqual(['turn.state']);
  });

  it('should append the receipts it settled without rewriting a document that needs no change', async () => {
    // Arrange
    const storage = await openStorage();
    await storage.writeState(ID, { id: ID, status: 'running', turn: 1, lastAnsweredQuestionToolUseId: 'tool-1' });
    const appended: AnswerOperationRecord[] = [];
    const subject = new SessionObservationApplier(
      storage,
      { append: async (_id, record) => void appended.push(record) },
      new KeyedSerialExecutor(),
    );
    const patch = patchFor(
      { lastAnsweredQuestionToolUseId: 'tool-1' },
      [question, released],
      new Map([['request-1', accepted]]),
    );
    const writes: unknown[] = [];
    storage.subscribeStates((_id, state) => writes.push(state));

    // Act
    const written = await subject.apply(ID, patch, NOW);

    // Assert
    should(patch.writes).be.false();
    should(written).be.false();
    should(appended.map(record => record.outcome)).deepEqual(['confirmed']);
    should(writes).deepEqual([]);
  });

  it('should re-decide under the lock: nothing to write once the document holds it, nothing over a damaged one', async () => {
    // Arrange — the look saw an open question nobody had recorded; by the time the patch is applied a
    // writer has recorded that picker already. Later the document is damaged.
    const storage = await openStorage();
    const subject = new SessionObservationApplier(
      storage,
      { append: async () => undefined },
      new KeyedSerialExecutor(),
    );
    const patch = patchFor({}, [question]);
    await storage.writeState(ID, {
      id: ID,
      status: 'awaiting_question',
      turn: 1,
      pendingQuestion: { toolUseId: 'tool-1', questions: [] },
    });

    // Act
    const decidedAgain = await subject.apply(ID, patch, NOW);
    await storage.writeState(ID, { id: ID, status: 'not-a-status' });
    const damaged = await subject.apply(ID, patch, NOW);

    // Assert
    should(decidedAgain).be.false();
    should(damaged).be.false();
    should(await storage.readState(ID)).deepEqual({ id: ID, status: 'not-a-status' });
  });
});
