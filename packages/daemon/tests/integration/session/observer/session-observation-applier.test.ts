/**
 * THE ONE WRITER of what a session observer derives, over real storage.
 *
 * One session's patches are applied one at a time in the order they were handed in (#689: a question
 * patch handed in before a turn patch lands first), receipts are appended even when nothing else
 * changes — but only while the ledger still owes them — and a question patch is re-decided against the
 * document it holds the lock on.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionState } from '@ferretry/protocol';
import should from 'should';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  FileAnswerLedger,
  KeyedSerialExecutor,
  RuntimeEnvironment,
  SessionObservationApplier,
  SqliteHomeLockFactory,
  storagePaneLimits,
  StateFileSystemFactory,
  StateHomeLayout,
  SystemClock,
} from '../../../../src/adapters/index.ts';
import {
  type AnswerOperationRecord,
  createSessionPaths,
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

/** The real receipt file beside the session, and what each of its lines says happened. */
function ledgerFor(storage: DaemonStorage) {
  const ledger = new FileAnswerLedger(
    session => createSessionPaths(storage.paths, session).directory,
    new SystemClock(() => new Date(NOW)),
  );
  const outcomes = async (): Promise<string[]> =>
    (await readFile(ledger.file(ID), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { readonly outcome: string; readonly resolution?: string })
      .map(row => row.resolution ?? row.outcome);
  return { ledger, outcomes };
}

const noReceipts = async () => new Map<string, AnswerOperationRecord>();

describe('SessionObservationApplier', () => {
  it('should apply one session’s patches in the order handed in: the question before the turn', async () => {
    // Arrange
    const storage = await openStorage();
    await storage.writeState(ID, { id: ID, status: 'running', turn: 1 });
    const appended: AnswerOperationRecord[] = [];
    const subject = new SessionObservationApplier(
      storage,
      { all: noReceipts, append: async (_id, record) => void appended.push(record) },
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
      {
        all: async () => new Map([[accepted.requestId, accepted]]),
        append: async (_id, record) => void appended.push(record),
      },
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
      { all: noReceipts, append: async () => undefined },
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

  it('should not settle again a receipt the answer drive settled after the look', async () => {
    // Arrange — a worker looked between the drive stamping the document and the drive appending its own
    // `confirmed`: its copy of the ledger still said `accepted`, so it settled the receipt itself.
    const storage = await openStorage();
    await storage.writeState(ID, { id: ID, status: 'running', turn: 1, lastAnsweredQuestionToolUseId: 'tool-1' });
    const { ledger, outcomes } = ledgerFor(storage);
    await ledger.append(ID, accepted);
    const patch = patchFor({ lastAnsweredQuestionToolUseId: 'tool-1' }, [question], new Map([['request-1', accepted]]));
    should(patch.settlements.map(record => record.outcome)).deepEqual(['confirmed']);
    await ledger.append(ID, { ...accepted, outcome: 'confirmed' });
    const subject = new SessionObservationApplier(storage, ledger, new KeyedSerialExecutor());

    // Act — the patch reaches the writer only now, with the answer key idle again.
    const written = await subject.apply(ID, patch, NOW);

    // Assert — one settlement, and it is the drive's.
    should(written).be.false();
    should(await outcomes()).deepEqual(['accepted', 'confirmed']);
    should(await ledger.read(ID, 'request-1')).deepEqual({ ...accepted, outcome: 'confirmed' });
  });

  it('should not lay a stale quarantine over the answer the drive confirmed, nor raise its advisory', async () => {
    // Arrange — mid-drive, the transcript showed the form advance before the document was stamped, so the
    // look quarantined the receipt and decided a released advisory. Then the drive confirmed the answer.
    const storage = await openStorage();
    const midDrive = {
      status: 'awaiting_question',
      pendingQuestion: { toolUseId: 'tool-1', questions: [] },
    } satisfies Partial<SessionState>;
    await storage.writeState(ID, { id: ID, turn: 1, ...midDrive });
    const { ledger, outcomes } = ledgerFor(storage);
    await ledger.append(ID, accepted);
    const patch = patchFor(midDrive, [question, released], new Map([['request-1', accepted]]));
    should(patch.settlements.map(record => record.outcome)).deepEqual(['quarantined']);
    should(patch.writes).be.true();
    const answered = { id: ID, status: 'running', turn: 1, lastAnsweredQuestionToolUseId: 'tool-1' } as const;
    await storage.writeState(ID, answered);
    await ledger.append(ID, { ...accepted, outcome: 'confirmed' });
    const subject = new SessionObservationApplier(storage, ledger, new KeyedSerialExecutor());

    // Act
    const written = await subject.apply(ID, patch, NOW);

    // Assert — the confirmed receipt stays the latest, so a retry of this request replays its answer
    // instead of being refused as released, and the document is left as the drive wrote it.
    should(written).be.false();
    should(await outcomes()).deepEqual(['accepted', 'confirmed']);
    should(await ledger.read(ID, 'request-1')).deepEqual({ ...accepted, outcome: 'confirmed' });
    should(await storage.readState(ID)).deepEqual(answered);
  });

  it('should settle a receipt the ledger still holds open, and decide the document from it', async () => {
    // Arrange — nothing settled the receipt since the look, so the monitor's settlement is the repair.
    const storage = await openStorage();
    await storage.writeState(ID, { id: ID, status: 'awaiting_question', turn: 1 });
    const { ledger, outcomes } = ledgerFor(storage);
    await ledger.append(ID, accepted);
    const patch = patchFor({}, [question, released], new Map([['request-1', accepted]]));
    const subject = new SessionObservationApplier(storage, ledger, new KeyedSerialExecutor());

    // Act
    const written = await subject.apply(ID, patch, NOW);

    // Assert
    should(written).be.true();
    should(await outcomes()).deepEqual(['accepted', 'quarantined']);
    should(await storage.readState(ID)).match({
      status: 'awaiting_user',
      needsHumanKind: 'structured-answer-released-unconfirmed',
    });
  });
});

describe('a session parked on the usage-limit dialog, over real storage', () => {
  const dialog = {
    id: '0123456789abcdef',
    harness: 'claude',
    kind: 'usage-limit',
    title: 'What do you want to do?',
    body: "You've hit your org's monthly spend limit",
    options: [
      { number: 1, label: 'Stop and wait for limit to reset', grantsTrust: false },
      { number: 2, label: 'Wait here, then continue automatically at Nov 1, 12am', grantsTrust: false },
    ],
    selected: 1,
  } as const;
  const config = {
    id: ID,
    incarnation: 'i1',
    runtimeGeneration: 1,
    name: 'limited',
    agent: 'claude-liftoff',
    harness: 'claude',
    modelHint: 'opus',
    mode: 'auto',
    remoteControl: false,
    harnessFlags: [],
    cwd: '/work',
    createdAt: NOW,
    updatedAt: NOW,
    turn: 1,
    intervalSeconds: 30,
    timeoutSeconds: 600,
    nudgeAfterSeconds: 120,
    killAfterSeconds: 900,
    directSendMaxChars: 4000,
    resumeMenuChoice: 'full',
    maxSnapshots: 5,
    retry: { transientAttempts: 2, stalledAttempts: 1, waitForQuotaReset: true, allowAccountFailover: false },
  };

  it('should record rate_limited, prove the login spent, then release it when the dialog closes', async () => {
    // Arrange
    const storage = await openStorage();
    await storage.writeConfig(ID, config);
    await storage.writeState(ID, { id: ID, status: 'running', turn: 1, turnState: 'working' });
    const subject = new SessionObservationApplier(
      storage,
      { all: noReceipts, append: async () => {} },
      new KeyedSerialExecutor(),
    );
    const nowMs = Date.parse(NOW);

    // Act
    await subject.apply(ID, { kind: 'turn', change: { from: 'working', to: 'needs-input', dialog } as never }, NOW);
    const limits = await storagePaneLimits(storage, nowMs);
    await subject.apply(ID, { kind: 'turn', change: { from: 'needs-input', to: undefined } }, NOW);
    const after = await storagePaneLimits(storage, nowMs);

    // Assert
    should([...limits.keys()]).deepEqual(['claude-liftoff']);
    should(limits.get('claude-liftoff')?.spend).be.true();
    should(after.size).equal(0);
    should(((await storage.readState(ID)) as { status: string }).status).equal('running');
  });

  it('should skip a limited session whose documents cannot be read', async () => {
    // Arrange
    const storage = await openStorage();
    await storage.writeConfig(ID, { id: ID });
    await storage.writeState(ID, { id: ID, status: 'rate_limited', turn: 1 });

    // Act
    const limits = await storagePaneLimits(storage, Date.parse(NOW));

    // Assert
    should(limits.size).equal(0);
  });
});
