/**
 * THE ONE WRITER of what a session observer derives, over real storage.
 *
 * One session's patches are applied one at a time in the order they were handed in (#689: a question
 * patch handed in before a turn patch lands first), receipts are appended even when nothing else
 * changes — but only while the ledger still owes them — and a question patch is re-decided against the
 * document it holds the lock on.
 */
import { afterEach, describe, it } from 'bun:test';
import type { SessionState } from '../../../../../daemon/lib/protocol/session.ts';
import should from 'should';
import {
  recordTurnChange,
  SessionObservationApplier,
} from '../../../../../daemon/adapters/session/observer/session-observation-applier.ts';
import { KeyedSerialExecutor } from '../../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import type { DaemonStorage } from '../../../../../daemon/adapters/storage/session-storage.ts';
import { type QuestionPatch, stepQuestion } from '../../../../../daemon/lib/session/observer/question.ts';
import type { AnswerOperationRecord } from '../../../../../daemon/lib/session/peers/question.ts';
import type { TranscriptEvent } from '../../../../../daemon/lib/session/peers/transcript.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { MemoryAnswerLedger } from '../../../../support/daemon/observer-peers.ts';
import {
  SCRIPTED_QUESTIONS,
  scriptedPaneLimits as storagePaneLimits,
} from '../../../../support/daemon/observer-stand-ins.ts';
import { FerretConfigFile, FerretStateFile } from '../../../../../contract/index.ts';
import { memoryStorage } from '../../../../support/daemon/storage.ts';

const NOW = '2026-10-22T08:00:00.000Z';
const ID = parseSessionId('applied-1');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function openFolder() {
  const opened = await memoryStorage({ clock: { now: () => NOW } });
  cleanups.push(async () => await opened.storage.close());
  return opened;
}

async function openStorage(): Promise<DaemonStorage> {
  return (await openFolder()).storage;
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
  const patch = stepQuestion(
    {
      state: { id: ID, status: 'running', turn: 1, ...state } as SessionState,
      events,
      answers,
    },
    SCRIPTED_QUESTIONS,
  );
  if (patch === undefined) throw new Error('the look implied nothing');
  return patch;
};

/** The receipt ledger beside the session (in memory: today's `FileAnswerLedger` is conversation's), and what each of its rows says happened. */
function ledgerFor(_storage: DaemonStorage) {
  const ledger = new MemoryAnswerLedger();
  const outcomes = async (): Promise<string[]> =>
    ledger
      .rows(ID)
      .map(row => row as AnswerOperationRecord & { readonly resolution?: string })
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
      SCRIPTED_QUESTIONS,
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
      SCRIPTED_QUESTIONS,
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
    // writer has stamped that very form as answered, which is what "the document holds it" means (the policy
    // keeps the projected form over a document that merely holds the same tool id). Later the document is damaged.
    const { storage, folder } = await openFolder();
    const subject = new SessionObservationApplier(
      storage,
      { all: noReceipts, append: async () => undefined },
      new KeyedSerialExecutor(),
      SCRIPTED_QUESTIONS,
    );
    const patch = patchFor({}, [question]);
    await storage.writeState(ID, {
      id: ID,
      status: 'running',
      turn: 1,
      lastAnsweredQuestionToolUseId: 'tool-1',
    });

    // Act
    const decidedAgain = await subject.apply(ID, patch, NOW);
    const damagedText = JSON.stringify({ format: 1, id: ID, status: 'not-a-status' });
    folder.plant(FerretStateFile, damagedText, ID);
    const damaged = await subject.apply(ID, patch, NOW);

    // Assert
    should(decidedAgain).be.false();
    should(damaged).be.false();
    should(folder.raw(FerretStateFile, ID)).equal(damagedText);
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
    const subject = new SessionObservationApplier(storage, ledger, new KeyedSerialExecutor(), SCRIPTED_QUESTIONS);

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
      pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Which one?' }] },
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
    const subject = new SessionObservationApplier(storage, ledger, new KeyedSerialExecutor(), SCRIPTED_QUESTIONS);

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
    const subject = new SessionObservationApplier(storage, ledger, new KeyedSerialExecutor(), SCRIPTED_QUESTIONS);

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
      SCRIPTED_QUESTIONS,
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
    const { storage, folder } = await openFolder();
    folder.plant(FerretConfigFile, JSON.stringify({ format: 1, id: ID }), ID);
    await storage.writeState(ID, { id: ID, status: 'rate_limited', turn: 1 });

    // Act
    const limits = await storagePaneLimits(storage, Date.parse(NOW));

    // Assert
    should(limits.size).equal(0);
  });
});

describe('recording a turn change that carries what the pane shows', () => {
  const request = {
    id: '0123456789abcdef',
    harness: 'claude',
    tool: 'Bash',
    action: 'run',
    question: 'Do you want to proceed?',
    options: [
      { number: 1, label: 'Yes', kind: 'allow' },
      { number: 2, label: 'No', kind: 'deny' },
    ],
    selected: 1,
  } as never;

  it('should record the prompt and the permission request beside the new turn state, and clear them with it', async () => {
    // Arrange
    const storage = await openStorage();
    await storage.writeState(ID, { id: ID, status: 'running', turn: 1, turnState: 'working' });

    // Act
    const parked = await recordTurnChange(
      storage,
      ID,
      { from: 'working', to: 'needs-input', prompt: 'Trust this folder?', request },
      NOW,
    );
    const during = (await storage.readState(ID)) as Record<string, unknown>;
    const cleared = await recordTurnChange(storage, ID, { from: 'needs-input', to: 'working' }, NOW);
    const after = (await storage.readState(ID)) as Record<string, unknown>;

    // Assert
    should([parked, cleared]).deepEqual([true, true]);
    should(during).containEql({ turnState: 'needs-input', turnPrompt: 'Trust this folder?' });
    should(during.permissionRequest).deepEqual(request);
    should(after.turnState).equal('working');
    should(Object.hasOwn(after, 'turnPrompt')).be.false();
    should(Object.hasOwn(after, 'permissionRequest')).be.false();
  });

  it('should raise a storage failure while deciding a question patch rather than call the document damaged', async () => {
    // Arrange: only a refused document is "nothing written"; a store that cannot answer is a fault the observer must see.
    const failing = {
      updateState: async () => {
        throw new Error('the state home is unreachable');
      },
      append: async () => undefined as never,
    };
    const subject = new SessionObservationApplier(
      failing as never,
      { all: noReceipts, append: async () => undefined },
      new KeyedSerialExecutor(),
      SCRIPTED_QUESTIONS,
    );

    // Act
    const failure = await subject.apply(ID, patchFor({}, [question]), NOW).catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).equal('the state home is unreachable');
  });
});
