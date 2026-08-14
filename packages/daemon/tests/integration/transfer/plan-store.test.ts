import { afterEach, describe, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { type FileHandle, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionTransferPlan } from '@ferretry/protocol';
import { InstantSchema, SessionTransferPlanSchema } from '@ferretry/protocol';
import should from 'should';
import {
  FileSessionTransferPlanStore,
  FileSessionTransferTargetPlanStore,
  forkReceiptPath,
  fsyncTransferPlanDirectory,
  fsyncTransferPlanFile,
  SessionTransferPlanConflictError,
  SessionTransferPlanCorruptError,
  type TransferReceipt,
  transferRequestFingerprint,
} from '../../../src/adapters/transfer/plan-store.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';
import { deriveTransferPlanId } from '../../../src/lib/transfer/prepare.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The authoritative fork receipt (daemon-global, plan-id-keyed) and the target-session plan copy, on
 * a real filesystem. The receipt round-trips, recovers the target id after a restart without touching
 * the source, refuses a request id reused for a different transfer, and keeps phase progress
 * append-only rather than conflicting.
 *
 * Everything here runs inside a throwaway directory; no state home is resolved.
 */

const SOURCE = 'source-session';
const REQUEST = 'req-1';
const PLAN_ID = deriveTransferPlanId(SOURCE, REQUEST);
const TARGET_PLAN_FILE = 'transfer-plan.json';

/** Deterministic temporary suffixes, so an atomic write is provable rather than incidental. */
function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `t${n}`;
  };
}

/** Deterministic instants, so a phase history reads in order. */
function clock(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `2025-01-0${n}T00:00:00+00:00`;
  };
}

/** Records completed directory flushes while still performing the real IO; this proves ordering, not power loss. */
function recordingDirectorySync(paths: string[]): (path: string) => Promise<void> {
  return async path => {
    await fsyncTransferPlanDirectory(path);
    paths.push(path);
  };
}

interface PinnedFileSyncObservation {
  readonly path: string;
  readonly inode: number;
  readonly unreadAfterParse: string;
}

/** Records a strict flush of the same open handle whose bytes were read and parsed. */
function recordingFileSync(
  paths: string[],
  observations: PinnedFileSyncObservation[] = [],
): (handle: FileHandle, path: string) => Promise<void> {
  return async (handle, path) => {
    const inode = (await handle.stat()).ino;
    // `readFile` advances a FileHandle's position. EOF here is deterministic proof that this is the
    // handle the store already read to parse its decision, rather than one it reopened by path.
    const unreadAfterParse = await handle.readFile('utf8');
    await fsyncTransferPlanFile(handle);
    observations.push({ path, inode, unreadAfterParse });
    paths.push(path);
  };
}

function errno(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(`injected ${code}`), { code });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Resolves to the rejection reason, failing loudly if the call unexpectedly resolved. */
async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

function makePlan(overrides: {
  planId?: string;
  preparedAt?: string;
  targetAgent?: string;
  targetAccount?: string;
  targetEffort?: string;
  cutByteOffset?: number;
  messageText?: string;
  durableCwd?: string;
}): SessionTransferPlan {
  return SessionTransferPlanSchema.parse({
    v: 1,
    planId: overrides.planId ?? PLAN_ID,
    preparedAt: overrides.preparedAt ?? '2025-01-01T00:00:00+00:00',
    source: {
      sessionId: SOURCE,
      incarnation: 'inc-1',
      runtimeGeneration: 1,
      harness: 'claude',
      agent: 'claude',
      model: 'sonnet',
      teammate: null,
      name: 'source',
      label: null,
      transcriptProvenance: { v: 1, home: '/home/cl', identity: 'undiscovered' },
      cutMessagePoint: { v: 1, byteOffset: overrides.cutByteOffset ?? 0, blockIndex: 0 },
    },
    target: {
      accountId: overrides.targetAccount ?? 'acc-1',
      agent: overrides.targetAgent ?? 'claude',
      harness: 'claude',
      model: 'sonnet',
      effort: overrides.targetEffort ?? null,
      contextWindow: 200000,
    },
    durable: {
      cwd: overrides.durableCwd ?? '/work',
      mode: 'auto',
      parentSessionId: null,
      boardAccess: 'none',
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
        messages: [
          {
            point: { v: 1, byteOffset: 0, blockIndex: 0 },
            role: 'user',
            text: overrides.messageText ?? 'carry this through the cut',
          },
        ],
      },
      attachments: { attachments: [] },
      references: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
      workspace: { cwd: '/work', head: null, status: null, repositorySnapshot: null },
      lineage: { wardenLineage: false, warden: null },
    },
    notCarried: [],
  });
}

interface Harness {
  readonly subject: FileSessionTransferPlanStore;
  readonly home: string;
  readonly forks: string;
}

async function harness(label: string): Promise<Harness> {
  const home = await tempDirectory(label);
  const forks = join(home, 'state', 'forks');
  const subject = new FileSessionTransferPlanStore(
    planId => forkReceiptPath(join(home, 'state'), planId),
    id => join(home, 'sessions', id, TARGET_PLAN_FILE),
    counter(),
    clock(),
  );
  return { subject, home, forks };
}

describe('deriveTransferPlanId', () => {
  it('is deterministic in the (source session, request id) pair and nothing else', () => {
    should(deriveTransferPlanId(SOURCE, REQUEST)).equal(deriveTransferPlanId(SOURCE, REQUEST));
    should(deriveTransferPlanId(SOURCE, REQUEST)).not.equal(deriveTransferPlanId(SOURCE, 'req-2'));
    should(deriveTransferPlanId(SOURCE, REQUEST)).not.equal(deriveTransferPlanId('other-session', REQUEST));
    should(deriveTransferPlanId(SOURCE, REQUEST)).match(/^[0-9a-f]{64}$/);
  });
});

describe('transferRequestFingerprint', () => {
  it('pins the whole frozen decision — every carried facet, durable setting and resolved target — not just the cut', () => {
    // The fingerprint is the request's identity: the FULL plan. preparedAt is the lone wall-clock
    // field and moves while the fingerprint must not.
    const base = makePlan({});
    should(transferRequestFingerprint(makePlan({ preparedAt: '2025-09-09T00:00:00+00:00' }))).equal(
      transferRequestFingerprint(base),
    );
    // The cut and the caller's agent/effort choice still differentiate the request.
    should(transferRequestFingerprint(makePlan({ cutByteOffset: 4096 }))).not.equal(transferRequestFingerprint(base));
    should(transferRequestFingerprint(makePlan({ targetAgent: 'codex' }))).not.equal(transferRequestFingerprint(base));
    should(transferRequestFingerprint(makePlan({ targetEffort: 'high' }))).not.equal(transferRequestFingerprint(base));
    // And so does every other resolved decision the cut-plus-choice fingerprint used to miss: a
    // carried conversation message, a durable setting, and the resolved target account.
    should(transferRequestFingerprint(makePlan({ messageText: 'a different carried conversation' }))).not.equal(
      transferRequestFingerprint(base),
    );
    should(transferRequestFingerprint(makePlan({ durableCwd: '/elsewhere' }))).not.equal(
      transferRequestFingerprint(base),
    );
    should(transferRequestFingerprint(makePlan({ targetAccount: 'acc-9' }))).not.equal(
      transferRequestFingerprint(base),
    );
  });
});

describe('FileSessionTransferPlanStore record/replay (authoritative global receipt)', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('persists the parsed plan and target id keyed by the composite plan id, before create', async () => {
    // The receipt is daemon-global under state/forks/<planId>.json, written ahead of lifecycle.create,
    // carrying the exact parsed plan and the pre-minted target id.
    // Arrange
    const { subject, forks } = await harness('transfer-receipt-record');
    const plan = makePlan({});

    // Act
    const outcome = await subject.record(plan, { requestId: REQUEST, targetId: 'target-session', phase: 'requested' });

    // Assert
    should(outcome.status).equal('created');
    should(outcome.phaseAppended).be.true();
    should(outcome.receipt.targetId).equal('target-session');
    should(outcome.receipt.plan.source.cutMessagePoint).deepEqual({ v: 1, byteOffset: 0, blockIndex: 0 });
    should(outcome.receipt.fingerprint).equal(transferRequestFingerprint(plan));
    should(subject.receiptPath(PLAN_ID)).equal(join(forks, `${PLAN_ID}.json`));
    should((await readdir(forks)).sort()).deepEqual([`${PLAN_ID}.json`]);
  });

  it('uses protocol-valid default instants when no clock is injected', async () => {
    // Arrange — deterministic temporary names, but deliberately no fourth constructor clock argument.
    const home = await tempDirectory('transfer-receipt-default-instant');
    const subject = new FileSessionTransferPlanStore(
      planId => forkReceiptPath(join(home, 'state'), planId),
      id => join(home, 'sessions', id, TARGET_PLAN_FILE),
      counter(),
    );

    // Act
    const outcome = await subject.record(makePlan({}), {
      requestId: REQUEST,
      targetId: 'target-session',
      phase: 'requested',
    });
    const receipt = await subject.load(PLAN_ID);
    if (receipt === undefined) throw new Error('expected the default-clock receipt to be persisted');

    // Assert — wall-clock values are intentionally not compared; the durable contract is an offset-bearing instant.
    should(outcome.status).equal('created');
    for (const instant of [receipt.createdAt, receipt.updatedAt, receipt.phaseHistory[0]?.at])
      should(InstantSchema.safeParse(instant).success).be.true();
  });

  it('round-trips the receipt, embedding the full parsed plan', async () => {
    // Arrange
    const { subject } = await harness('transfer-receipt-roundtrip');
    await subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-session', phase: 'requested' });

    // Act
    const receipt = await subject.load(PLAN_ID);
    if (receipt === undefined) throw new Error('expected a recorded receipt');

    // Assert — the recovered plan is schema-valid and decision-identical to what was recorded.
    const plan = SessionTransferPlanSchema.parse(receipt.plan);
    should(plan.planId).equal(PLAN_ID);
    should(receipt.targetId).equal('target-session');
    should(receipt.phaseHistory).have.length(1);
    should(receipt.phaseHistory[0]?.phase).equal('requested');
  });

  it('recovers the target id and plan after a restart, without reading the source', async () => {
    // A crash after the receipt is written but before import completes: a fresh store process reads
    // the durable receipt by plan id and gets back the exact target id and plan. The source session
    // directory is never opened — it does not even exist on disk.
    // Arrange
    const { subject, home } = await harness('transfer-receipt-restart');
    await subject.record(makePlan({}), {
      requestId: REQUEST,
      targetId: 'target-session',
      phase: 'replacement_creating',
    });
    const state = join(home, 'state');
    const forks = join(state, 'forks');
    const receiptFile = subject.receiptPath(PLAN_ID);
    const beforeReplay = await stat(receiptFile);
    const syncs: string[] = [];
    const fileSyncs: PinnedFileSyncObservation[] = [];

    // Act — a NEW process, NEW store instance, same state tree.
    const restarted = new FileSessionTransferPlanStore(
      planId => forkReceiptPath(state, planId),
      id => join(home, 'sessions', id, TARGET_PLAN_FILE),
      counter(),
      clock(),
      recordingDirectorySync(syncs),
      recordingFileSync(syncs, fileSyncs),
    );
    const recovered = await restarted.replay(PLAN_ID);
    if (recovered === undefined) throw new Error('expected a recoverable receipt');

    // Assert
    should(recovered.receipt.targetId).equal('target-session');
    should(recovered.plan.planId).equal(PLAN_ID);
    should(recovered.plan.facets.conversation?.messages[0]?.text).equal('carry this through the cut');
    // Recovery re-flushes the existing inode and its names before downstream work; it does not
    // rewrite the receipt. The empty read remainder proves the parser and fsync used one retained
    // handle; its inode is the receipt that was present before recovery, not a path reopen.
    should(syncs).deepEqual([receiptFile, state, forks]);
    should(fileSyncs).deepEqual([{ path: receiptFile, inode: beforeReplay.ino, unreadAfterParse: '' }]);
    const afterReplay = await stat(receiptFile);
    should(afterReplay.ino).equal(beforeReplay.ino);
    should(afterReplay.mtimeMs).equal(beforeReplay.mtimeMs);
    // Source immutability, held by construction: the source session directory was never created.
    should(existsSync(join(home, 'sessions', SOURCE))).be.false();
  });

  it('appends a new phase rather than conflicting when the same request advances', async () => {
    // Phase progress is append-only history, NOT a conflict basis. Re-recording the same request at a
    // later seam phase appends to phaseHistory and leaves the plan untouched.
    // Arrange
    const { subject } = await harness('transfer-receipt-phase');
    await subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-session', phase: 'requested' });

    // Act
    const advanced = await subject.record(makePlan({}), {
      requestId: REQUEST,
      targetId: 'target-session',
      phase: 'replacement_creating',
    });

    // Assert
    should(advanced.status).equal('replayed');
    should(advanced.phaseAppended).be.true();
    should(advanced.receipt.phaseHistory.map(entry => entry.phase)).deepEqual(['requested', 'replacement_creating']);
  });

  it('refuses a request id reused for a different cut, target agent, effort or target session', async () => {
    // THE FINGERPRINT IS AUTHORIZATION. The composite key (source, request) arrives with a different
    // request, so the refusal is outright and the durable receipt stands.
    // Arrange
    const { subject } = await harness('transfer-receipt-conflict');
    await subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-a', phase: 'requested' });

    // Act + Assert — same composite key, four ways the request can differ.
    const differentCut = await reject(
      subject.record(makePlan({ cutByteOffset: 4096 }), {
        requestId: REQUEST,
        targetId: 'target-a',
        phase: 'requested',
      }),
    );
    should(differentCut).be.instanceOf(SessionTransferPlanConflictError);
    should((differentCut as SessionTransferPlanConflictError).conflict).equal('payload_mismatch');

    const differentAgent = await reject(
      subject.record(makePlan({ targetAgent: 'codex' }), {
        requestId: REQUEST,
        targetId: 'target-a',
        phase: 'requested',
      }),
    );
    should((differentAgent as SessionTransferPlanConflictError).conflict).equal('payload_mismatch');

    const differentEffort = await reject(
      subject.record(makePlan({ targetEffort: 'high' }), {
        requestId: REQUEST,
        targetId: 'target-a',
        phase: 'requested',
      }),
    );
    should((differentEffort as SessionTransferPlanConflictError).conflict).equal('payload_mismatch');

    const differentTarget = await reject(
      subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-b', phase: 'requested' }),
    );
    should((differentTarget as SessionTransferPlanConflictError).conflict).equal('payload_mismatch');

    // The anchor still records the original decision and target.
    should((await subject.load(PLAN_ID))?.targetId).equal('target-a');
  });

  it('reuses the frozen plan P0 on replay and refuses a re-prepare that drifted, never replacing it', async () => {
    // A source is live: its transcript and facets can move between the first prepare and a crashed
    // retry. The durable receipt freezes P0, so a replay that arrives carrying a re-prepared P1 — a
    // different decision under the same plan id — is refused outright, and the frozen P0 is left
    // intact rather than overwritten.
    // Arrange
    const { subject } = await harness('transfer-receipt-p0-frozen');
    await subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-session', phase: 'requested' });

    // Act — a re-prepare whose conversation facet moved (the source grew past the cut), same plan id.
    const drifted = await reject(
      subject.record(makePlan({ messageText: 'the source transcript grew past the cut' }), {
        requestId: REQUEST,
        targetId: 'target-session',
        phase: 'replacement_creating',
      }),
    );

    // Assert — the drift is a different decision, so it is refused; nothing was appended.
    should(drifted).be.instanceOf(SessionTransferPlanConflictError);
    should((drifted as SessionTransferPlanConflictError).conflict).equal('payload_mismatch');
    const recovered = await subject.load(PLAN_ID);
    if (recovered === undefined) throw new Error('expected the frozen receipt');
    should(recovered.plan.facets.conversation?.messages[0]?.text).equal('carry this through the cut');
    should(recovered.phaseHistory).have.length(1);
  });

  it('keys receipts globally by plan id: distinct (source, request) pairs are distinct files', async () => {
    // Arrange
    const { subject, forks } = await harness('transfer-receipt-keyed');
    const otherRequest = 'req-2';
    const otherPlanId = deriveTransferPlanId(SOURCE, otherRequest);
    const otherPlan = makePlan({ planId: otherPlanId });

    // Act
    await subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-1', phase: 'requested' });
    await subject.record(otherPlan, { requestId: otherRequest, targetId: 'target-2', phase: 'requested' });

    // Assert
    should((await readdir(forks)).sort()).deepEqual([`${PLAN_ID}.json`, `${otherPlanId}.json`].sort());
  });

  it('reports a corrupt receipt rather than pretending no transfer was recorded', async () => {
    // Arrange
    const { subject } = await harness('transfer-receipt-corrupt');
    await subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-session', phase: 'requested' });
    await Bun.write(subject.receiptPath(PLAN_ID), '{ not a receipt');

    // Act + Assert
    await should(subject.load(PLAN_ID)).be.rejectedWith(SessionTransferPlanCorruptError);
  });

  it('parses an authoritative replay before flushing it or any directory name', async () => {
    // Arrange — valid JSON with an invalid receipt shape reaches schema parsing, which must complete
    // before the pinned-file sync. A corrupt anchor earns no durability claim and no directory barrier.
    const { subject, home } = await harness('transfer-receipt-corrupt-replay-order');
    await subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-session', phase: 'requested' });
    await Bun.write(subject.receiptPath(PLAN_ID), '{}\n');
    const syncs: string[] = [];
    const restarted = new FileSessionTransferPlanStore(
      planId => forkReceiptPath(join(home, 'state'), planId),
      id => join(home, 'sessions', id, TARGET_PLAN_FILE),
      counter(),
      clock(),
      recordingDirectorySync(syncs),
      recordingFileSync(syncs),
    );

    // Act
    const error = await reject(restarted.replay(PLAN_ID));

    // Assert
    should(error).be.instanceOf(SessionTransferPlanCorruptError);
    should(syncs).deepEqual([]);
  });

  it('writes the receipt privately and atomically, leaving no temporary file beside it', async () => {
    // Arrange
    const { subject, forks } = await harness('transfer-receipt-atomic');

    // Act
    await subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-session', phase: 'requested' });

    // Assert
    should(await readdir(forks)).deepEqual([`${PLAN_ID}.json`]);
    should((await stat(subject.receiptPath(PLAN_ID))).mode & 0o777).equal(0o600);
    should((await stat(forks)).mode & 0o777).equal(0o700);
  });

  it('syncs created receipt directories parent-first and retains the concurrent-leaf guard in steady state', async () => {
    // Arrange — only the temp root exists. The first write must make state/forks durable; subsequent
    // writes still sync state before publishing because another key may have observed a concurrent
    // creator's forks directory even when its own recursive mkdir returned `undefined`.
    const home = await tempDirectory('transfer-receipt-sync-order');
    const state = join(home, 'state');
    const forks = join(state, 'forks');
    const syncs: string[] = [];
    const fileSyncs: PinnedFileSyncObservation[] = [];
    const subject = new FileSessionTransferPlanStore(
      planId => forkReceiptPath(state, planId),
      id => join(home, 'sessions', id, TARGET_PLAN_FILE),
      counter(),
      clock(),
      recordingDirectorySync(syncs),
      recordingFileSync(syncs, fileSyncs),
    );

    // Act + Assert — created entry parents first, then the receipt's containing directory after rename.
    await subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-session', phase: 'requested' });
    should(syncs).deepEqual([home, state, forks]);

    // A real steady-state replacement creates no directory, but retains the state-directory guard.
    syncs.length = 0;
    await subject.record(makePlan({}), {
      requestId: REQUEST,
      targetId: 'target-session',
      phase: 'replacement_creating',
    });
    should(syncs).deepEqual([state, forks]);

    // An exact replay does not replace the document, but it must repair a prior writer that died
    // after rename and before its directory sync: final file, lazy-directory parent guard, then leaf.
    const receiptFile = subject.receiptPath(PLAN_ID);
    const beforeReplay = await stat(receiptFile);
    syncs.length = 0;
    await subject.record(makePlan({}), {
      requestId: REQUEST,
      targetId: 'target-session',
      phase: 'replacement_creating',
    });
    should(syncs).deepEqual([receiptFile, state, forks]);
    should(fileSyncs).deepEqual([{ path: receiptFile, inode: beforeReplay.ino, unreadAfterParse: '' }]);
    const afterReplay = await stat(receiptFile);
    should(afterReplay.ino).equal(beforeReplay.ino);
    should(afterReplay.mtimeMs).equal(beforeReplay.mtimeMs);
  });

  it('makes an observer of a concurrently created receipt directory sync its parent before publishing', async () => {
    // Arrange — caller one creates `forks` and pauses before syncing its name into `state`. Caller two
    // then observes the directory, so its recursive mkdir returns `undefined`; it must not publish a
    // different receipt until it has independently synced `state`.
    const home = await tempDirectory('transfer-receipt-concurrent-directory');
    const state = join(home, 'state');
    const forks = join(state, 'forks');
    await mkdir(state, { recursive: true, mode: 0o700 });
    await fsyncTransferPlanDirectory(home);
    const firstPaused = deferred();
    const releaseFirst = deferred();
    const syncs: string[] = [];
    let pauseNextStateSync = true;
    const subject = new FileSessionTransferPlanStore(
      planId => forkReceiptPath(state, planId),
      id => join(home, 'sessions', id, TARGET_PLAN_FILE),
      counter(),
      clock(),
      async path => {
        if (path === state && pauseNextStateSync) {
          pauseNextStateSync = false;
          firstPaused.resolve();
          await releaseFirst.promise;
        }
        await fsyncTransferPlanDirectory(path);
        syncs.push(path);
      },
    );
    const firstWrite = subject.record(makePlan({}), {
      requestId: REQUEST,
      targetId: 'target-1',
      phase: 'requested',
    });
    await firstPaused.promise;
    const secondRequest = 'req-2';
    const secondPlanId = deriveTransferPlanId(SOURCE, secondRequest);

    // Act — caller two completes while caller one remains paused at the parent sync.
    try {
      await subject.record(makePlan({ planId: secondPlanId }), {
        requestId: secondRequest,
        targetId: 'target-2',
        phase: 'requested',
      });
    } finally {
      releaseFirst.resolve();
      await firstWrite;
    }

    // Assert — caller two's state/forks pair precedes caller one's delayed pair. Without the
    // unconditional parent guard its first entry would be `forks`, allowing it to return too early.
    should(syncs).deepEqual([state, forks, state, forks]);
  });
});

describe('FileSessionTransferPlanStore refuses a corrupt durable anchor', () => {
  afterEach(async () => await cleanupTempDirectories());

  /** Records the canonical receipt and returns it parsed, as the on-disk source of every mutation. */
  async function recordedReceipt(subject: FileSessionTransferPlanStore): Promise<TransferReceipt> {
    await subject.record(makePlan({}), { requestId: REQUEST, targetId: 'target-session', phase: 'requested' });
    const receipt = await subject.load(PLAN_ID);
    if (receipt === undefined) throw new Error('expected a recorded receipt');
    return receipt;
  }

  /** Overwrites the receipt file with a hand-mutated document, simulating a torn or edited anchor. */
  async function overwriteReceipt(subject: FileSessionTransferPlanStore, doc: unknown): Promise<void> {
    await Bun.write(subject.receiptPath(PLAN_ID), `${JSON.stringify(doc)}\n`);
  }

  it('refuses a receipt whose embedded plan carries a different plan id', async () => {
    // A receipt keyed as plan A but embedding plan B must not redirect recovery at a different session.
    const { subject } = await harness('transfer-receipt-corrupt-nested-plan-id');
    const receipt = await recordedReceipt(subject);
    await overwriteReceipt(subject, { ...receipt, plan: { ...receipt.plan, planId: '0'.repeat(64) } });
    await should(subject.load(PLAN_ID)).be.rejectedWith(SessionTransferPlanCorruptError);
  });

  it('refuses a receipt whose outer source session no longer derives its plan id', async () => {
    const { subject } = await harness('transfer-receipt-corrupt-source');
    const receipt = await recordedReceipt(subject);
    await overwriteReceipt(subject, { ...receipt, sourceSessionId: 'a-different-session' });
    await should(subject.load(PLAN_ID)).be.rejectedWith(SessionTransferPlanCorruptError);
  });

  it('refuses a receipt whose fingerprint no longer matches the frozen plan', async () => {
    const { subject } = await harness('transfer-receipt-corrupt-fingerprint');
    const receipt = await recordedReceipt(subject);
    await overwriteReceipt(subject, { ...receipt, fingerprint: 'f'.repeat(64) });
    await should(subject.load(PLAN_ID)).be.rejectedWith(SessionTransferPlanCorruptError);
  });

  it('refuses a receipt whose phase history entry is malformed', async () => {
    const { subject } = await harness('transfer-receipt-corrupt-phase');
    const receipt = await recordedReceipt(subject);
    await overwriteReceipt(subject, { ...receipt, phaseHistory: [{ phase: '', at: receipt.createdAt }] });
    await should(subject.load(PLAN_ID)).be.rejectedWith(SessionTransferPlanCorruptError);
  });

  it('refuses a receipt whose cut message point dropped the durable block index', async () => {
    // blockIndex is required: several messages can share a JSONL record and byte offset, so a point
    // without it is ambiguous and must not be replayed.
    const { subject } = await harness('transfer-receipt-corrupt-block-index');
    const receipt = await recordedReceipt(subject);
    await overwriteReceipt(subject, {
      ...receipt,
      plan: { ...receipt.plan, source: { ...receipt.plan.source, cutMessagePoint: { v: 1, byteOffset: 0 } } },
    });
    await should(subject.load(PLAN_ID)).be.rejectedWith(SessionTransferPlanCorruptError);
  });
});

describe('FileSessionTransferPlanStore install (target plan copy)', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('installs the plan into the target session directory after create, idempotently', async () => {
    // Arrange
    const { subject, home } = await harness('transfer-plan-install');
    const target = parseSessionId('target-session');
    const frozen = makePlan({});

    // Act
    const first = await subject.install(target, frozen);
    const second = await subject.install(target, frozen);

    // Assert — a replay re-installs the same plan id and leaves the file untouched.
    should(first.status).equal('installed');
    should(second.status).equal('present');
    should(subject.targetPlanPath(target)).equal(join(home, 'sessions', 'target-session', TARGET_PLAN_FILE));
    const onDisk = SessionTransferPlanSchema.parse(JSON.parse(await readFile(subject.targetPlanPath(target), 'utf8')));
    should(onDisk.planId).equal(PLAN_ID);
  });

  it('refuses a different frozen plan even when it reuses the same plan id', async () => {
    const { subject } = await harness('transfer-plan-same-id-drift');
    const target = parseSessionId('target-session');
    await subject.install(target, makePlan({}));

    const error = await reject(subject.install(target, makePlan({ preparedAt: '2025-08-08T00:00:00+00:00' })));

    should(error).be.instanceOf(SessionTransferPlanConflictError);
    should((error as SessionTransferPlanConflictError).conflict).equal('session_claimed');
  });

  it('refuses to install a second plan id into a target one transfer already created', async () => {
    // Arrange
    const { subject } = await harness('transfer-plan-claim');
    const target = parseSessionId('target-session');
    await subject.install(target, makePlan({}));

    // Act + Assert — a different plan id cannot supplant the target's provenance.
    const otherPlanId = deriveTransferPlanId(SOURCE, 'req-2');
    const error = await reject(subject.install(target, makePlan({ planId: otherPlanId })));
    should(error).be.instanceOf(SessionTransferPlanConflictError);
    should((error as SessionTransferPlanConflictError).conflict).equal('session_claimed');
  });

  it('writes the target plan privately, with no temporary file left beside it', async () => {
    // Arrange
    const { subject } = await harness('transfer-plan-atomic');
    const target = parseSessionId('target-session');
    const directory = dirname(subject.targetPlanPath(target));

    // Act
    await subject.install(target, makePlan({}));

    // Assert
    should((await readdir(directory)).sort()).deepEqual([TARGET_PLAN_FILE]);
    should((await stat(subject.targetPlanPath(target))).mode & 0o777).equal(0o600);
  });

  it('syncs every target directory entry it creates parent-first before syncing the published plan', async () => {
    // Arrange — this exercises the defensive recursive-mkdir path. Production normally receives an
    // already-created session directory from lifecycle creation.
    const home = await tempDirectory('transfer-target-plan-created-sync-order');
    const sessions = join(home, 'sessions');
    const target = parseSessionId('target-session');
    const targetDirectory = join(sessions, target);
    const syncs: string[] = [];
    const subject = new FileSessionTransferTargetPlanStore(
      id => join(sessions, id, TARGET_PLAN_FILE),
      counter(),
      recordingDirectorySync(syncs),
    );

    // Act
    await subject.install(target, makePlan({}));

    // Assert — the names `sessions` and `target-session` live in home and sessions respectively;
    // the final target-directory flush follows rename and persists the plan entry itself.
    should(syncs).deepEqual([home, sessions, targetDirectory]);
  });

  it('persists the full state-anchored target chain on first write and exact replay without replacing it', async () => {
    // Arrange — even an established target can have been made visible by a lifecycle attempt that has
    // not completed its own parent barriers, so this store persists the whole name chain for itself.
    const home = await tempDirectory('transfer-target-plan-steady-sync-order');
    const sessions = join(home, 'sessions');
    const target = parseSessionId('target-session');
    const targetDirectory = join(sessions, target);
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const syncs: string[] = [];
    const fileSyncs: PinnedFileSyncObservation[] = [];
    const subject = new FileSessionTransferTargetPlanStore(
      id => join(sessions, id, TARGET_PLAN_FILE),
      counter(),
      recordingDirectorySync(syncs),
      recordingFileSync(syncs, fileSyncs),
    );
    const frozen = makePlan({});

    // Act + Assert — state and sessions first, then the target after rename publishes the plan.
    await subject.install(target, frozen);
    should(syncs).deepEqual([home, sessions, targetDirectory]);

    const planFile = subject.targetPlanPath(target);
    const beforeReplay = await stat(planFile);
    syncs.length = 0;
    await subject.install(target, frozen);
    should(syncs).deepEqual([planFile, home, sessions, targetDirectory]);
    should(fileSyncs).deepEqual([{ path: planFile, inode: beforeReplay.ino, unreadAfterParse: '' }]);
    const afterReplay = await stat(planFile);
    should(afterReplay.ino).equal(beforeReplay.ino);
    should(afterReplay.mtimeMs).equal(beforeReplay.mtimeMs);
  });

  it('stops owning a temporary immediately after rename, before a failing directory sync can yield', async () => {
    // Arrange — the state/sessions parent barriers complete before publication. Pause specifically at
    // the target-directory barrier after rename, reuse the now-vacant deterministic temporary name
    // from another writer, then fail the first operation. Its finally must not unlink a name its
    // successful rename already consumed.
    const home = await tempDirectory('transfer-target-plan-temp-reuse');
    const sessions = join(home, 'sessions');
    const target = parseSessionId('target-session');
    const targetDirectory = join(sessions, target);
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const planFile = join(targetDirectory, TARGET_PLAN_FILE);
    const reusedTemporary = `${planFile}.fixed.tmp`;
    const syncEntered = deferred();
    const releaseSync = deferred();
    const failure = errno('EIO');
    const subject = new FileSessionTransferTargetPlanStore(
      id => join(sessions, id, TARGET_PLAN_FILE),
      () => 'fixed',
      async path => {
        if (path !== targetDirectory) {
          await fsyncTransferPlanDirectory(path);
          return;
        }
        syncEntered.resolve();
        await releaseSync.promise;
        throw failure;
      },
    );
    const failedInstall = reject(subject.install(target, makePlan({})));
    await syncEntered.promise;

    // Act — this is genuinely between rename and the first writer's rejected return.
    try {
      await writeFile(reusedTemporary, 'another writer\n', { encoding: 'utf8', mode: 0o600 });
    } finally {
      releaseSync.resolve();
    }
    const error = await failedInstall;

    // Assert — publication is visible despite the failed durability barrier, and cleanup leaves the
    // independently owned reused name intact for its real owner.
    should(error).equal(failure);
    should(SessionTransferPlanSchema.parse(JSON.parse(await readFile(planFile, 'utf8'))).planId).equal(PLAN_ID);
    should(await readFile(reusedTemporary, 'utf8')).equal('another writer\n');
  });

  it('tolerates exactly the unsupported errnos across directory open and sync, and propagates others', async () => {
    // A platform that cannot fsync directories degrades only name durability; refusing cannot repair
    // that platform limit. Each case still exercises a real directory open/close around the injected
    // handle-sync error, then proves the install semantics completed.
    for (const code of ['EINVAL', 'ENOTSUP', 'EPERM']) {
      const home = await tempDirectory(`transfer-target-plan-dir-${code.toLowerCase()}`);
      const target = parseSessionId('target-session');
      const sessions = join(home, 'sessions');
      const targetDirectory = join(sessions, target);
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      const syncs: string[] = [];
      const subject = new FileSessionTransferTargetPlanStore(
        id => join(home, 'sessions', id, TARGET_PLAN_FILE),
        counter(),
        async path => {
          syncs.push(path);
          await fsyncTransferPlanDirectory(path, async () => {
            throw errno(code);
          });
        },
      );

      const outcome = await subject.install(target, makePlan({}));

      should(outcome.status).equal('installed');
      should(syncs).deepEqual([home, sessions, targetDirectory]);
      should((await subject.load(target))?.planId).equal(PLAN_ID);
    }

    // A real failure is not a platform capability answer and must stop the operation.
    const home = await tempDirectory('transfer-target-plan-dir-eio');
    const target = parseSessionId('target-session');
    const targetDirectory = join(home, 'sessions', target);
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const failure = errno('EIO');
    const strict = new FileSessionTransferTargetPlanStore(
      id => join(home, 'sessions', id, TARGET_PLAN_FILE),
      counter(),
      async path =>
        await fsyncTransferPlanDirectory(path, async () => {
          throw failure;
        }),
    );

    const error = await reject(strict.install(target, makePlan({})));

    should(error).equal(failure);

    // The same policy covers filesystems that refuse the DIRECTORY OPEN rather than its later fsync.
    // This runs through the production function and the real store operation, not a catch in the test.
    const openHome = await tempDirectory('transfer-target-plan-dir-open-eperm');
    const openSessions = join(openHome, 'sessions');
    const openTarget = parseSessionId('target-session');
    const openTargetDirectory = join(openSessions, openTarget);
    await mkdir(openTargetDirectory, { recursive: true, mode: 0o700 });
    const openSyncs: string[] = [];
    const unsupportedOpen = new FileSessionTransferTargetPlanStore(
      id => join(openSessions, id, TARGET_PLAN_FILE),
      counter(),
      async path => {
        openSyncs.push(path);
        await fsyncTransferPlanDirectory(path, fsyncTransferPlanFile, async () => {
          throw errno('EPERM');
        });
      },
    );

    const openedOutcome = await unsupportedOpen.install(openTarget, makePlan({}));

    should(openedOutcome.status).equal('installed');
    should(openSyncs).deepEqual([openHome, openSessions, openTargetDirectory]);

    // An open refusal outside the exact capability set remains a real failure and stops publication.
    const strictOpenHome = await tempDirectory('transfer-target-plan-dir-open-eio');
    const strictOpenSessions = join(strictOpenHome, 'sessions');
    const strictOpenTarget = parseSessionId('target-session');
    await mkdir(join(strictOpenSessions, strictOpenTarget), { recursive: true, mode: 0o700 });
    const openFailure = errno('EIO');
    const strictOpen = new FileSessionTransferTargetPlanStore(
      id => join(strictOpenSessions, id, TARGET_PLAN_FILE),
      counter(),
      async path =>
        await fsyncTransferPlanDirectory(path, fsyncTransferPlanFile, async () => {
          throw openFailure;
        }),
    );

    const openError = await reject(strictOpen.install(strictOpenTarget, makePlan({})));

    should(openError).equal(openFailure);
    should(await strictOpen.load(strictOpenTarget)).equal(undefined);
  });

  it('propagates a pinned file-sync failure and never begins the directory barrier', async () => {
    // Arrange — EINVAL is deliberately tolerated for a DIRECTORY sync and never for a file. The
    // exact replay has already read and parsed the plan when its pinned handle fails to flush.
    const home = await tempDirectory('transfer-target-plan-file-sync-strict');
    const sessions = join(home, 'sessions');
    const target = parseSessionId('target-session');
    const targetDirectory = join(sessions, target);
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const planFile = join(targetDirectory, TARGET_PLAN_FILE);
    const frozen = makePlan({});
    await new FileSessionTransferTargetPlanStore(id => join(sessions, id, TARGET_PLAN_FILE), counter()).install(
      target,
      frozen,
    );
    const beforeReplay = await stat(planFile);
    const directorySyncs: string[] = [];
    const failure = errno('EINVAL');
    let unreadAfterParse: string | undefined;
    const restarted = new FileSessionTransferTargetPlanStore(
      id => join(sessions, id, TARGET_PLAN_FILE),
      counter(),
      recordingDirectorySync(directorySyncs),
      async handle => {
        unreadAfterParse = await handle.readFile('utf8');
        throw failure;
      },
    );

    // Act
    const error = await reject(restarted.install(target, frozen));

    // Assert — strict file failure first; no parent or leaf directory sync follows it, and no rewrite
    // took place while trying to repair an exact visible plan.
    should(error).equal(failure);
    should(unreadAfterParse).equal('');
    should(directorySyncs).deepEqual([]);
    should((await stat(planFile)).ino).equal(beforeReplay.ino);
  });
});

describe('FileSessionTransferTargetPlanStore capability boundary', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('owns only the target plan and exposes no global receipt writer or path', async () => {
    const home = await tempDirectory('transfer-target-plan-only');
    const subject = new FileSessionTransferTargetPlanStore(
      id => join(home, 'sessions', id, TARGET_PLAN_FILE),
      counter(),
    );
    const target = parseSessionId('target-session');

    should(Object.getOwnPropertyNames(Object.getPrototypeOf(subject))).not.containEql('record');
    should(Object.getOwnPropertyNames(Object.getPrototypeOf(subject))).not.containEql('receiptPath');
    should(await subject.load(target)).equal(undefined);
    should((await subject.install(target, makePlan({}))).status).equal('installed');
    should((await subject.load(target))?.planId).equal(PLAN_ID);
    should(subject.targetPlanPath(target)).equal(join(home, 'sessions', 'target-session', TARGET_PLAN_FILE));
  });
});
