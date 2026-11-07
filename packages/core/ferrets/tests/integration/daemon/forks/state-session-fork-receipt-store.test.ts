import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { ForkFiles } from '../../../../contract/index.ts';
import type { SessionTransferPlan } from '../../../../contract/transfer.ts';
import { SessionTransferPlanSchema } from '../../../../contract/transfer.ts';
import {
  forkReceiptName,
  StateSessionForkReceiptStore,
} from '../../../../daemon/adapters/forks/state-session-fork-receipt-store.ts';
import {
  SessionForkPhaseRegressionError,
  SessionForkReceiptInvalidError,
} from '../../../../daemon/lib/forks/failures.ts';
import {
  type SessionForkCommand,
  type SessionForkKey,
  sessionForkFingerprint,
} from '../../../../daemon/lib/forks/identity.ts';
import {
  advanceSessionForkReceipt,
  claimSessionForkReceipt,
  parseSessionForkReceipt,
  SESSION_FORK_PHASES,
  type SessionForkImportReport,
  type SessionForkPhase,
  type SessionForkReceipt,
} from '../../../../daemon/lib/forks/receipt.ts';
import { deriveTransferPlanId } from '../../../../daemon/lib/transfer/prepare.ts';

/**
 * The durable fork receipt store on the kernel's state port: the claim is a real compare-and-set (one winner, one
 * target), the advance is monotonic and never overwrites a mismatch, a torn document is refused rather than treated as
 * unclaimed, a fresh store replays the same receipt, and the source session is never touched.
 *
 * What the file-system store used to prove itself — the fsync ordering, the pinned inode, the temporary names — is the
 * state port's rule for every document it writes, and is proved by the kernel's own tests; this file proves what is
 * the RECEIPT's: the key, the monotonic phase and the refusal of a document that is not this pair's. The folder is the
 * kernel test host's, so nothing here touches a disk.
 */

const SOURCE = 'source-session';
const REQUEST = 'req-1';
const PLAN_ID = deriveTransferPlanId(SOURCE, REQUEST);
const KEY: SessionForkKey = { sourceSessionId: SOURCE, requestId: REQUEST };
const CLAIMED_AT = '2025-01-01T00:00:00+00:00';
const SELECTION_BINDING = 's1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Resolves to the rejection reason, failing loudly if the call unexpectedly resolved. */
async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** An increasing instant for each phase stamp, after the claim. */
function atFor(phase: SessionForkPhase): string {
  return `2025-01-0${SESSION_FORK_PHASES.indexOf(phase) + 2}T00:00:00+00:00`;
}

function makePlan(key: SessionForkKey = KEY): SessionTransferPlan {
  return SessionTransferPlanSchema.parse({
    v: 1,
    planId: deriveTransferPlanId(key.sourceSessionId, key.requestId),
    preparedAt: CLAIMED_AT,
    source: {
      sessionId: key.sourceSessionId,
      incarnation: 'inc-1',
      runtimeGeneration: 1,
      harness: 'claude',
      agent: 'claude',
      model: 'sonnet',
      teammate: null,
      name: 'source',
      label: null,
      transcriptProvenance: { v: 1, home: '/home/cl', identity: 'undiscovered' },
      cutMessagePoint: { v: 1, byteOffset: 0, blockIndex: 0 },
    },
    target: {
      accountId: 'acc-1',
      agent: 'claude',
      harness: 'claude',
      model: 'sonnet',
      effort: null,
      contextWindow: 200000,
    },
    durable: {
      cwd: '/work',
      mode: 'auto',
      parentSessionId: null,
      label: null,
      harnessFlags: [],
      remoteControl: false,
      intervalSeconds: 1,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 0,
      resumeMenuChoice: 'full',
      maxSnapshots: 1,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    },
    facets: {
      conversation: {
        messages: [{ point: { v: 1, byteOffset: 0, blockIndex: 0 }, role: 'user', text: 'carry this through the cut' }],
      },
      attachments: { attachments: [] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd: '/work', head: null, status: null, repositorySnapshot: null },
      lineage: { wardenLineage: false, warden: null },
    },
    notCarried: [],
  });
}

function commandFor(plan: SessionTransferPlan): SessionForkCommand {
  if (plan.source.cutMessagePoint === null) throw new Error('fixture fork plan must carry a cut point');
  return {
    through: plan.source.cutMessagePoint,
    selectionBinding: SELECTION_BINDING,
    agent: plan.target.agent,
    model: plan.target.model,
    effort: plan.target.effort,
  };
}

/** The receipt as it is first written: a reserved target and an exact plan, frozen at the claim. */
function claimedReceipt(targetSessionId = 'target-session', key: SessionForkKey = KEY): SessionForkReceipt {
  const plan = makePlan(key);
  return claimSessionForkReceipt({
    key,
    requestFingerprint: sessionForkFingerprint(commandFor(plan)),
    targetSessionId,
    plan,
    at: CLAIMED_AT,
  });
}

/** The import report the `imported` phase stamps onto the receipt. */
const IMPORT_REPORT: SessionForkImportReport = {
  briefPath: 'target-session/turns/turn-001.md',
  copiedAttachmentIds: [],
};

interface Harness {
  readonly subject: StateSessionForkReceiptStore;
  readonly folder: MemoryStateFolder;
}

function harness(folder: MemoryStateFolder = new MemoryStateFolder()): Harness {
  return { subject: new StateSessionForkReceiptStore(folder.port([ForkFiles])), folder };
}

async function readParsed(subject: StateSessionForkReceiptStore): Promise<SessionForkReceipt> {
  return parseSessionForkReceipt(await subject.read(KEY), KEY);
}

/** Every phase after the claim, in order, so a test can drive a receipt to the end. */
async function driveToCompleted(subject: StateSessionForkReceiptStore, claimed: SessionForkReceipt): Promise<void> {
  let receipt = claimed;
  for (const phase of SESSION_FORK_PHASES.slice(1) as readonly SessionForkPhase[]) {
    const report = phase === 'imported' ? IMPORT_REPORT : undefined;
    receipt = advanceSessionForkReceipt(receipt, { phase, at: atFor(phase), report });
    await subject.advance(receipt);
  }
}

describe('StateSessionForkReceiptStore read', () => {
  it('should answer undefined for a pair that was never claimed', async () => {
    // Arrange
    const { subject } = harness();

    // Act + Assert
    should(await subject.read(KEY)).be.undefined();
  });
});

describe('StateSessionForkReceiptStore claim (atomic compare-and-set)', () => {
  it('should write the receipt under the plan-derived name and read it back', async () => {
    // Arrange
    const { subject, folder } = harness();
    const claimed = claimedReceipt();

    // Act — the winner of an uncontested claim gets its own receipt back.
    const won = await subject.claim(claimed);

    // Assert
    should(won).deepEqual(claimed);
    should(forkReceiptName(KEY)).equal(PLAN_ID);
    should([...folder.files.keys()].filter(path => path.includes(PLAN_ID))).have.length(1);
    // read returns the document, which round-trips to the exact receipt.
    should(await readParsed(subject)).deepEqual(claimed);
  });

  it('should be a compare-and-set: a second claim adopts the holder and never overwrites it', async () => {
    // Arrange
    const { subject } = harness();
    const first = claimedReceipt('target-a');
    should(await subject.claim(first)).deepEqual(first);

    // Act — a different reserved target under the same key: the store does NOT decide the conflict, it answers
    // with the holder so the orchestration can adopt the winner's target.
    const second = claimedReceipt('target-b');
    const adopted = await subject.claim(second);

    // Assert
    should(adopted).not.deepEqual(second);
    should((adopted as SessionForkReceipt).targetSessionId).equal('target-a');
    // The holder was never overwritten.
    should(await readParsed(subject)).deepEqual(first);
  });

  it('should resolve concurrent claims under one key to one winner and one target, never two', async () => {
    // Arrange
    const { subject, folder } = harness();

    // Act — two claims race for the same key with different reserved targets.
    const [a, b] = await Promise.all([
      subject.claim(claimedReceipt('target-a')),
      subject.claim(claimedReceipt('target-b')),
    ]);

    // Assert — exactly one receipt document exists, recording one target id.
    should([...folder.files.keys()].filter(path => path.includes(PLAN_ID))).have.length(1);
    const winningTarget = (await readParsed(subject)).targetSessionId;
    should(['target-a', 'target-b']).containEql(winningTarget);
    // Both claims answer with the SAME holder: the loser adopted the winner rather than minting a second target,
    // which is what stops two attempts creating two sessions.
    should((a as SessionForkReceipt).targetSessionId).equal(winningTarget);
    should((b as SessionForkReceipt).targetSessionId).equal(winningTarget);
  });

  it('should refuse to mint over a corrupt receipt, so a retry cannot create a second target', async () => {
    // Arrange
    const { subject, folder } = harness();
    await subject.claim(claimedReceipt());
    folder.plant(ForkFiles, '{ not a receipt', PLAN_ID);

    // Act + Assert — a retry finds the pair already held; the claim must refuse rather than overwrite the anchor.
    await should(subject.claim(claimedReceipt())).be.rejectedWith(SessionForkReceiptInvalidError);
    should(folder.raw(ForkFiles, PLAN_ID)).equal('{ not a receipt');
  });
});

describe('StateSessionForkReceiptStore advance (monotonic, never overwrites a mismatch)', () => {
  it('should cross every phase monotonically and let read reflect each boundary', async () => {
    // Arrange
    const { subject } = harness();
    let receipt = claimedReceipt();
    await subject.claim(receipt);

    // Act + Assert
    for (const phase of SESSION_FORK_PHASES.slice(1) as readonly SessionForkPhase[]) {
      const report = phase === 'imported' ? IMPORT_REPORT : undefined;
      receipt = advanceSessionForkReceipt(receipt, { phase, at: atFor(phase), report });
      await subject.advance(receipt);
      const held = await readParsed(subject);
      should(held.phase).equal(phase);
      should(held.phaseHistory.at(-1)?.phase).equal(phase);
    }
    should(receipt.phase).equal('completed');
    should(receipt.report).deepEqual(IMPORT_REPORT);
  });

  it('should refuse to move a receipt backwards to an earlier phase', async () => {
    // Arrange — drive the receipt forward to `imported`.
    const { subject } = harness();
    let receipt = claimedReceipt();
    await subject.claim(receipt);
    for (const phase of ['target_created', 'plan_persisted'] as const) {
      receipt = advanceSessionForkReceipt(receipt, { phase, at: atFor(phase) });
      await subject.advance(receipt);
    }
    receipt = advanceSessionForkReceipt(receipt, { phase: 'imported', at: atFor('imported'), report: IMPORT_REPORT });
    await subject.advance(receipt);

    // Act — a late, schema-valid `target_created` receipt is a regression against the `imported` one on disk.
    const late = advanceSessionForkReceipt(claimedReceipt(), { phase: 'target_created', at: atFor('target_created') });
    const error = await reject(subject.advance(late));

    // Assert
    should(error).be.instanceOf(SessionForkPhaseRegressionError);
    should((await readParsed(subject)).phase).equal('imported');
  });

  it('should refuse an advance for a different decision and leave the frozen receipt intact', async () => {
    // Arrange
    const { subject } = harness();
    await subject.claim(claimedReceipt('target-session'));

    // Act — a different reserved target is a different decision: the full-decision fingerprint covers it.
    const error = await reject(subject.advance(claimedReceipt('other-target')));

    // Assert
    should(error).be.instanceOf(SessionForkReceiptInvalidError);
    should((await readParsed(subject)).targetSessionId).equal('target-session');
  });

  it('should leave the receipt untouched when an advance that already landed is replayed', async () => {
    // Arrange
    const { subject, folder } = harness();
    const claimed = claimedReceipt();
    await subject.claim(claimed);
    const atTargetCreated = advanceSessionForkReceipt(claimed, {
      phase: 'target_created',
      at: atFor('target_created'),
    });
    await subject.advance(atTargetCreated);
    const bytesAfterFirst = folder.raw(ForkFiles, PLAN_ID);
    // Any write from here on "crashes" the process after it lands, so a replay that wrote would throw.
    folder.armCrash();

    // Act — re-advancing the same receipt is a no-op: the boundary is already crossed, so the state port is told to
    // decline the write.
    await subject.advance(atTargetCreated);

    // Assert
    should(folder.crashed).be.false();
    should((await readParsed(subject)).phase).equal('target_created');
    should(folder.raw(ForkFiles, PLAN_ID)).equal(bytesAfterFirst);
  });

  it('should refuse when no durable receipt holds the pair', async () => {
    // Arrange
    const { subject, folder } = harness();

    // Act + Assert — and it must not create one: an advance never mints.
    await should(subject.advance(claimedReceipt())).be.rejectedWith(SessionForkReceiptInvalidError);
    should(folder.raw(ForkFiles, PLAN_ID)).be.undefined();
  });
});

describe('StateSessionForkReceiptStore refuses a corrupt or unknown durable anchor', () => {
  it('should refuse a torn receipt on read rather than treating it as unclaimed', async () => {
    // Arrange
    const { subject, folder } = harness();
    await subject.claim(claimedReceipt());
    folder.plant(ForkFiles, '{ not a receipt', PLAN_ID);

    // Act + Assert — a torn receipt must not read as undefined (which would trigger a fresh claim and a second target).
    await should(subject.read(KEY)).be.rejectedWith(SessionForkReceiptInvalidError);
  });

  it('should refuse to advance a receipt whose version it does not recognise', async () => {
    // Arrange
    const { subject, folder } = harness();
    folder.plant(ForkFiles, JSON.stringify({ format: 1, v: 2 }), PLAN_ID);

    // Act + Assert
    await should(subject.advance(claimedReceipt())).be.rejectedWith(SessionForkReceiptInvalidError);
  });

  it('should refuse a receipt stored under this pair that belongs to another pair', async () => {
    // Arrange — a valid receipt for another request, planted under this pair's name.
    const { subject, folder } = harness();
    const other = claimedReceipt('target-session', { sourceSessionId: SOURCE, requestId: 'req-2' });
    folder.plant(ForkFiles, JSON.stringify({ format: 1, ...other }), PLAN_ID);

    // Act + Assert — the key check is what stops one caller's fork being reported as another's.
    await should(subject.read(KEY).then(document => parseSessionForkReceipt(document, KEY))).be.rejectedWith(
      SessionForkReceiptInvalidError,
    );
  });
});

describe('StateSessionForkReceiptStore durability and source immutability', () => {
  it('should let a fresh store instance read the durable receipt and advance it without re-claiming', async () => {
    // Arrange
    const folder = new MemoryStateFolder();
    const first = harness(folder).subject;
    const claimed = claimedReceipt();
    await first.claim(claimed);
    await first.advance(advanceSessionForkReceipt(claimed, { phase: 'target_created', at: atFor('target_created') }));

    // Act — a new process, new store instance, same state.
    const restarted = harness(folder).subject;
    const held = parseSessionForkReceipt(await restarted.read(KEY), KEY);
    await restarted.advance(advanceSessionForkReceipt(held, { phase: 'plan_persisted', at: atFor('plan_persisted') }));

    // Assert
    should(held.phase).equal('target_created');
    should(parseSessionForkReceipt(await restarted.read(KEY), KEY).phase).equal('plan_persisted');
  });

  it('should declare the receipt private, because it carries the conversation the fork cut', () => {
    // Assert — the document holds the frozen plan, conversation text included, so it is as private as a session's own
    // configuration (0600), as the file store always wrote it.
    should(ForkFiles.mode).equal(0o600);
  });

  it('should write only the daemon-global receipt, never under or through the source session', async () => {
    // Arrange
    const { subject, folder } = harness();
    const claimed = claimedReceipt();
    await subject.claim(claimed);

    // Act
    await driveToCompleted(subject, claimed);

    // Assert — one document, named by the plan id; the source's own name appears in no path.
    const paths = [...folder.files.keys(), ...folder.bytes.keys()];
    should(paths).have.length(1);
    should(paths[0]).containEql(PLAN_ID);
    should(paths.some(path => path.split('/').includes(SOURCE))).be.false();
  });
});
