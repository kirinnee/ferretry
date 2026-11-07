import { beforeEach, describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import type { MemoryStateFolder } from '@ferretry/kernel/testing';
import { err } from '@ferretry/std';
import type { SessionHandoverReceipt } from '../../../../../contract/handover.ts';
import type { SessionTransferPlan } from '../../../../../contract/transfer.ts';
import should from 'should';
import { HandoverFiles } from '../../../../../contract/handover-state.ts';
import { memoryHandoverState } from '../../../../support/daemon/handover-state.ts';
import { FileHandoverReceiptStore } from '../../../../../daemon/adapters/moves/handover/file-handover-receipt-store.ts';
import { handoverPlanId } from '../../../../../daemon/lib/moves/handover/policy.ts';
import { HandoverReceiptDamagedError } from '../../../../../daemon/lib/moves/handover/types.ts';

const AT = '2026-02-01T00:00:00.000Z';
const PLAN_ID = handoverPlanId('source-1', 'req-1');

const ACCOUNT = {
  accountId: 'acct-codex',
  agent: 'codex-main',
  harness: 'codex',
  model: null,
  effort: null,
  contextWindow: 400_000,
} as const;

let folder: MemoryStateFolder;
let state: StatePort;

beforeEach(() => {
  ({ folder, state } = memoryHandoverState());
});

/** Plants a document as the kernel stores one: the format number first, then the body. */
function plant(name: string, body: unknown): void {
  folder.plant(HandoverFiles, JSON.stringify({ format: 1, ...(body as object) }), name);
}

function receipt(overrides: Partial<SessionHandoverReceipt> = {}): SessionHandoverReceipt {
  return {
    requestId: 'req-1',
    fingerprint: 'fp',
    sourceSessionId: 'source-1',
    sourceHarness: 'claude',
    sourceAgent: 'claude-main',
    reason: 'the claude account is out of quota',
    resolvedTarget: { replacement: ACCOUNT, coordinator: null },
    planId: PLAN_ID,
    plan: plan(),
    board: null,
    phase: 'requested',
    phaseHistory: [{ phase: 'requested', at: AT }],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function plan(planId = PLAN_ID): SessionTransferPlan {
  return {
    v: 1,
    planId,
    preparedAt: AT,
    source: {
      sessionId: 'source-1',
      incarnation: 'source-1-1',
      runtimeGeneration: 1,
      harness: 'claude',
      agent: 'claude-main',
      model: null,
      teammate: null,
      name: 'ada',
      label: null,
      transcriptProvenance: null,
      cutMessagePoint: null,
    },
    target: {
      accountId: 'acct-codex',
      agent: 'codex-main',
      harness: 'codex',
      model: null,
      effort: null,
      contextWindow: 400_000,
    },
    durable: {
      cwd: '/work/repo',
      mode: 'interactive',
      parentSessionId: null,
      label: null,
      harnessFlags: [],
      remoteControl: false,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4000,
      resumeMenuChoice: 'full',
      maxSnapshots: 5,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    },
    facets: {
      conversation: null,
      attachments: { attachments: [] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd: '/work/repo', head: null, status: null, repositorySnapshot: null },
      lineage: { wardenLineage: false, warden: null },
    },
    notCarried: [],
  };
}

describe('FileHandoverReceiptStore', () => {
  it('should round-trip a receipt through the state port, stored with its format first', async () => {
    // Arrange
    const store = new FileHandoverReceiptStore(state);
    should(await store.read('source-1')).be.null();

    // Act
    await store.write(receipt());

    // Assert
    should(await store.read('source-1')).deepEqual(receipt());
    should(folder.raw(HandoverFiles, 'source-1')).startWith('{"format":1,');
  });

  it('should parse on the way out, so this daemon cannot write a document a later one refuses', async () => {
    // Arrange
    const store = new FileHandoverReceiptStore(state);

    // Act / Assert — a history that does not end at the current phase is exactly what the durable schema forbids.
    await should(store.write(receipt({ phase: 'invited' }))).be.rejected();
    should(await store.read('source-1')).be.null();
    should(folder.raw(HandoverFiles, 'source-1')).be.undefined();
  });

  it('should refuse a damaged document rather than reading it as absence', async () => {
    // Arrange
    const store = new FileHandoverReceiptStore(state);
    folder.plant(HandoverFiles, '{ not json', 'source-1');

    // Act / Assert
    await should(store.read('source-1')).be.rejectedWith(HandoverReceiptDamagedError);
    plant('source-1', { requestId: 'req-1' });
    const error = await store.read('source-1').catch((thrown: unknown) => thrown);
    should(error).be.instanceof(HandoverReceiptDamagedError);
    should((error as HandoverReceiptDamagedError).file).equal('source-1/handover.json');
  });

  it('should refuse a read the state port answered with anything but absence', async () => {
    // Arrange — the port reports an io fault: a document that is there but cannot be read.
    const broken: StatePort = {
      ...state,
      read: async () =>
        err({ file: '*/handover.json', reason: 'io', sentence: '*/handover.json cannot be used: it cannot be read.' }),
    };
    const store = new FileHandoverReceiptStore(broken);

    // Act / Assert
    await should(store.read('source-1')).be.rejectedWith(HandoverReceiptDamagedError);
  });

  it('should list only the sessions whose handover has not finished', async () => {
    // Arrange
    const store = new FileHandoverReceiptStore(state);
    await store.write(receipt());
    await store.write(
      receipt({
        sourceSessionId: 'source-2',
        planId: handoverPlanId('source-2', 'req-1'),
        plan: {
          ...plan(handoverPlanId('source-2', 'req-1')),
          source: { ...plan().source, sessionId: 'source-2' },
        },
        phase: 'refused',
        phaseHistory: [
          { phase: 'requested', at: AT },
          { phase: 'refused', at: AT },
        ],
        refusal: { failure: 'board_busy', message: 'the board already carries an outstanding invitation' },
      }),
    );

    // Act / Assert — a session with no receipt at all is simply not on the roster.
    should(await store.pendingSourceSessionIds()).deepEqual(['source-1']);
  });

  it('should refuse a receipt found in another session directory, and keep it off the roster', async () => {
    // Arrange
    const store = new FileHandoverReceiptStore(state);
    plant('source-2', receipt());

    // Act / Assert
    await should(store.read('source-2')).be.rejectedWith(HandoverReceiptDamagedError);
    await should(store.pendingSourceSessionIds()).be.rejectedWith(HandoverReceiptDamagedError);
  });

  it('should refuse a roster that has a damaged receipt in it, rather than skipping the one most in need of finishing', async () => {
    // Arrange
    const store = new FileHandoverReceiptStore(state);
    await store.write(receipt());
    folder.plant(HandoverFiles, '{ not json', 'source-2');

    // Act / Assert
    await should(store.pendingSourceSessionIds()).be.rejectedWith(HandoverReceiptDamagedError);
  });

  it('should refuse a receipt whose plan id is not the one its own source and request derive', async () => {
    // Arrange
    const store = new FileHandoverReceiptStore(state);
    const forged = handoverPlanId('somebody-else', 'req-1');
    // Both copies agree with each other, which is exactly what a swapped plan would look like.
    plant('source-1', receipt({ planId: forged, plan: plan(forged) }));

    // Act
    const error = await store.read('source-1').catch((thrown: unknown) => thrown);

    // Assert
    should(error).be.instanceof(HandoverReceiptDamagedError);
    should((error as HandoverReceiptDamagedError).detail).match(/is not the one handover req-1 of source-1 derives/u);
  });

  it('should refuse to build a path out of a session id it does not recognise', async () => {
    // Arrange
    const store = new FileHandoverReceiptStore(state);

    // Act / Assert
    await should(store.read('../escape')).be.rejectedWith(/not a session id/u);
    await should(store.read('')).be.rejectedWith(/not a session id/u);
    await should(store.write(receipt({ sourceSessionId: '../escape' }))).be.rejected();
  });

  it('should answer an empty roster when no session holds a receipt yet', async () => {
    // Arrange
    const store = new FileHandoverReceiptStore(state);

    // Act / Assert
    should(await store.pendingSourceSessionIds()).be.empty();
  });

  it('should refuse a roster the state port cannot list, rather than answering an empty one', async () => {
    // Arrange
    const broken: StatePort = {
      ...state,
      list: async () => {
        throw new Error('the state folder could not be listed');
      },
    };
    const store = new FileHandoverReceiptStore(broken);

    // Act
    const failure = await store.pendingSourceSessionIds().then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    // Assert
    should(failure?.message).equal('the state folder could not be listed');
  });
});
