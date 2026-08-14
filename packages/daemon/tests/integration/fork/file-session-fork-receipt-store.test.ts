import { afterEach, describe, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionTransferPlan } from '@ferretry/protocol';
import { SessionTransferPlanSchema } from '@ferretry/protocol';
import should from 'should';
import {
  FileSessionForkReceiptStore,
  forkReceiptFile,
  NodeSessionForkReceiptFileOperations,
  type SessionForkReceiptFileOperations,
} from '../../../src/adapters/fork/file-session-fork-receipt-store.ts';
import { SessionForkPhaseRegressionError, SessionForkReceiptInvalidError } from '../../../src/lib/fork/failures.ts';
import {
  type SessionForkCommand,
  type SessionForkKey,
  sessionForkFingerprint,
} from '../../../src/lib/fork/identity.ts';
import {
  advanceSessionForkReceipt,
  claimSessionForkReceipt,
  parseSessionForkReceipt,
  SESSION_FORK_PHASES,
  type SessionForkImportReport,
  type SessionForkPhase,
  type SessionForkReceipt,
} from '../../../src/lib/fork/receipt.ts';
import { deriveTransferPlanId } from '../../../src/lib/transfer/prepare.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The durable fork receipt store on a real filesystem: the claim is a real compare-and-set (one
 * winner, one target), the advance is monotonic and never overwrites a mismatch, a torn file is
 * refused rather than treated as unclaimed, a fresh process replays the same receipt, and the source
 * session directory is never touched. Three durability properties are proved by making the hazard
 * happen: a read, an adoption and an equal-phase replay answer from and persist ONE pinned inode
 * even once its name is gone; a rename hands the temporary name away, so a later failure cannot
 * unlink a stranger who reused it; and a directory fsync tolerates exactly the refusals that mean
 * the filesystem has none, while a file fsync stays strict. Everything runs inside a throwaway
 * directory.
 */

const SOURCE = 'source-session';
const REQUEST = 'req-1';
const PLAN_ID = deriveTransferPlanId(SOURCE, REQUEST);
const KEY: SessionForkKey = { sourceSessionId: SOURCE, requestId: REQUEST };
const SECOND_KEY: SessionForkKey = { sourceSessionId: SOURCE, requestId: 'req-2' };
const CLAIMED_AT = '2025-01-01T00:00:00+00:00';
const SELECTION_BINDING = 's1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * Real filesystem operations with a completed-operation trace and two optional barriers: one before
 * a directory fsync, and one after a pinned read has the bytes but before that same handle is
 * fsynced — the window in which a name can stop meaning what it meant.
 */
class RecordingReceiptFileOperations implements SessionForkReceiptFileOperations {
  readonly calls: string[] = [];
  private readonly inner = new NodeSessionForkReceiptFileOperations();

  constructor(
    private readonly beforeSync?: (path: string) => Promise<void>,
    private readonly beforePinnedSync?: (path: string) => Promise<void>,
  ) {}

  async ensureDirectory(path: string, mode: number): Promise<string | undefined> {
    const created = await this.inner.ensureDirectory(path, mode);
    this.calls.push(`ensure:${path}:${created ?? 'existing'}`);
    return created;
  }

  async writePrivateSynced(path: string, contents: string, mode: number): Promise<void> {
    await this.inner.writePrivateSynced(path, contents, mode);
    // This operation resolves only after exclusive open -> write -> file fsync -> close.
    this.calls.push(`write-synced-closed:${path}`);
  }

  async link(from: string, to: string): Promise<void> {
    try {
      await this.inner.link(from, to);
      this.calls.push(`link:${from}->${to}`);
    } catch (error) {
      this.calls.push(`link-refused:${from}->${to}`);
      throw error;
    }
  }

  async replace(from: string, to: string): Promise<void> {
    await this.inner.replace(from, to);
    this.calls.push(`replace:${from}->${to}`);
  }

  async readPinned<T>(
    path: string,
    use: (text: string, syncPinned: () => Promise<void>) => Promise<T>,
  ): Promise<T | undefined> {
    return await this.inner.readPinned(path, async (text, syncPinned) => {
      // The bytes are in hand and the handle is still open: everything the caller decides from here
      // is decided on this one inode.
      this.calls.push(`read:${path}`);
      return await use(text, async () => {
        await this.beforePinnedSync?.(path);
        await syncPinned();
        this.calls.push(`sync-file:${path}`);
      });
    });
  }

  async syncDirectory(path: string): Promise<void> {
    await this.beforeSync?.(path);
    await this.inner.syncDirectory(path);
    this.calls.push(`sync-directory:${path}`);
  }

  async discard(path: string): Promise<void> {
    await this.inner.discard(path);
    this.calls.push(`discard:${path}`);
  }
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

/** A deterministic temporary-name source that fails rather than silently reusing a name. */
function uniqueIds(...ids: string[]): () => string {
  return () => {
    const id = ids.shift();
    if (id === undefined) throw new Error('test exhausted its temporary ids');
    return id;
  };
}

/** Fires on the first barrier only, so a later repair in the same test sees an ordinary file. */
function once(action: (path: string) => Promise<void>): (path: string) => Promise<void> {
  let fired = false;
  return async path => {
    if (fired) return;
    fired = true;
    await action(path);
  };
}

/** An errno failure with exactly the code a filesystem would report. */
function errno(code: string): Error {
  return Object.assign(new Error(`fsync refused with ${code}`), { code });
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
  readonly subject: FileSessionForkReceiptStore;
  readonly home: string;
  readonly state: string;
  readonly forks: string;
}

async function harness(
  label: string,
  options: {
    readonly uniqueId?: () => string;
    readonly files?: SessionForkReceiptFileOperations;
  } = {},
): Promise<Harness> {
  const home = await tempDirectory(label);
  const state = join(home, 'state');
  const forks = join(state, 'forks');
  const subject = new FileSessionForkReceiptStore(key => forkReceiptFile(state, key), options.uniqueId, options.files);
  return { subject, home, state, forks };
}

async function readParsed(subject: FileSessionForkReceiptStore): Promise<SessionForkReceipt> {
  return parseSessionForkReceipt(await subject.read(KEY), KEY);
}

describe('FileSessionForkReceiptStore read', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('answers undefined for a pair that was never claimed', async () => {
    const { subject } = await harness('fork-receipt-read-empty');
    should(await subject.read(KEY)).be.undefined();
  });
});

describe('FileSessionForkReceiptStore host-power-loss durability ordering', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('syncs every newly created directory entry parent-first before writing, then syncs the linked receipt', async () => {
    const files = new RecordingReceiptFileOperations();
    const { subject, home, state, forks } = await harness('fork-receipt-first-directory-sync', {
      uniqueId: uniqueIds('claim'),
      files,
    });
    const file = forkReceiptFile(state, KEY);
    const temporary = `${file}.claim.tmp`;

    await subject.claim(claimedReceipt());

    should(files.calls).deepEqual([
      `ensure:${forks}:${state}`,
      `sync-directory:${home}`,
      `sync-directory:${state}`,
      `write-synced-closed:${temporary}`,
      `link:${temporary}->${file}`,
      `sync-directory:${forks}`,
      `discard:${temporary}`,
    ]);
  });

  it('on a steady-state claim re-syncs only the immediate parent before writing and the leaf after linking', async () => {
    const files = new RecordingReceiptFileOperations();
    const { subject, state, forks } = await harness('fork-receipt-steady-directory-sync', {
      uniqueId: uniqueIds('first', 'second'),
      files,
    });
    await subject.claim(claimedReceipt());
    files.calls.length = 0;

    const second = claimedReceipt('target-two', SECOND_KEY);
    const file = forkReceiptFile(state, SECOND_KEY);
    const temporary = `${file}.second.tmp`;
    await subject.claim(second);

    should(files.calls).deepEqual([
      `ensure:${forks}:existing`,
      `sync-directory:${state}`,
      `write-synced-closed:${temporary}`,
      `link:${temporary}->${file}`,
      `sync-directory:${forks}`,
      `discard:${temporary}`,
    ]);
  });

  it('syncs and closes advance bytes before rename, then syncs the containing directory', async () => {
    const files = new RecordingReceiptFileOperations();
    const { subject, state, forks } = await harness('fork-receipt-advance-sync', {
      uniqueId: uniqueIds('claim', 'advance'),
      files,
    });
    const claimed = claimedReceipt();
    await subject.claim(claimed);
    files.calls.length = 0;

    const file = forkReceiptFile(state, KEY);
    const temporary = `${file}.advance.tmp`;
    await subject.advance(advanceSessionForkReceipt(claimed, { phase: 'target_created', at: atFor('target_created') }));

    // No `sync-file`: a forward advance abandons the inode it read instead of persisting it. No
    // `discard` either: the rename consumed the temporary name, which this writer no longer owns.
    should(files.calls).deepEqual([
      `read:${file}`,
      `write-synced-closed:${temporary}`,
      `replace:${temporary}->${file}`,
      `sync-directory:${forks}`,
    ]);
  });

  it('drops temporary ownership at the rename, so a failed directory sync cannot unlink a reused name', async () => {
    const { subject: seeded, state, forks } = await harness('fork-receipt-temp-reuse-after-rename');
    const claimed = claimedReceipt();
    await seeded.claim(claimed);
    const file = forkReceiptFile(state, KEY);
    const temporary = `${file}.reused.tmp`;
    const laterWriterBytes = 'a later writer generated the same name and owns these bytes';

    // The directory sync fails only after the rename has already consumed this writer's temporary
    // name, and a later writer has meanwhile created its own private file under that same name.
    const files = new RecordingReceiptFileOperations(async path => {
      if (path !== forks) return;
      await writeFile(temporary, laterWriterBytes, { mode: 0o600 });
      throw new Error('simulated directory sync failure after the rename');
    });
    const subject = new FileSessionForkReceiptStore(key => forkReceiptFile(state, key), uniqueIds('reused'), files);

    await should(
      subject.advance(advanceSessionForkReceipt(claimed, { phase: 'target_created', at: atFor('target_created') })),
    ).be.rejectedWith('simulated directory sync failure after the rename');

    // The failure is reported, the renamed receipt stands, and the stranger's bytes are untouched.
    should(await readFile(temporary, 'utf8')).equal(laterWriterBytes);
    should(files.calls).deepEqual([
      `read:${file}`,
      `write-synced-closed:${temporary}`,
      `replace:${temporary}->${file}`,
    ]);
    should((await readParsed(seeded)).phase).equal('target_created');
  });

  it('repairs a phase visible after process death before rename sync on both read and equal advance', async () => {
    const { subject, state, forks } = await harness('fork-receipt-restart-repairs-rename');
    const claimed = claimedReceipt();
    await subject.claim(claimed);
    const file = forkReceiptFile(state, KEY);

    const targetCreated = advanceSessionForkReceipt(claimed, {
      phase: 'target_created',
      at: atFor('target_created'),
    });
    const firstCrashFiles = new RecordingReceiptFileOperations(async path => {
      if (path === forks) throw new Error('simulated process death after target-created rename');
    });
    const firstCrash = new FileSessionForkReceiptStore(
      key => forkReceiptFile(state, key),
      uniqueIds('target-created-crash'),
      firstCrashFiles,
    );
    const firstTemporary = `${file}.target-created-crash.tmp`;

    // The rename is visible from page cache, but the throwing directory sync models the process
    // disappearing before it can establish that name as power-loss durable.
    await should(firstCrash.advance(targetCreated)).be.rejectedWith(
      'simulated process death after target-created rename',
    );
    should(firstCrashFiles.calls).deepEqual([
      `read:${file}`,
      `write-synced-closed:${firstTemporary}`,
      `replace:${firstTemporary}->${file}`,
    ]);

    // A separate store instance is the restarted process. It must repair the visible inode and name
    // before returning the later phase that SessionForkService will use to skip target creation.
    const readRepairFiles = new RecordingReceiptFileOperations();
    const restartedReader = new FileSessionForkReceiptStore(
      key => forkReceiptFile(state, key),
      uniqueIds('unused-read-id'),
      readRepairFiles,
    );
    should(parseSessionForkReceipt(await restartedReader.read(KEY), KEY).phase).equal('target_created');
    should(readRepairFiles.calls).deepEqual([`read:${file}`, `sync-file:${file}`, `sync-directory:${forks}`]);

    const planPersisted = advanceSessionForkReceipt(targetCreated, {
      phase: 'plan_persisted',
      at: atFor('plan_persisted'),
    });
    const secondCrashFiles = new RecordingReceiptFileOperations(async path => {
      if (path === forks) throw new Error('simulated process death after plan-persisted rename');
    });
    const secondCrash = new FileSessionForkReceiptStore(
      key => forkReceiptFile(state, key),
      uniqueIds('plan-persisted-crash'),
      secondCrashFiles,
    );
    await should(secondCrash.advance(planPersisted)).be.rejectedWith(
      'simulated process death after plan-persisted rename',
    );

    // Service normally repairs through `read`, but a direct equal-phase replay is safe too: it does
    // not rewrite history, yet it seals the exact inode and directory entry the dead process exposed.
    const equalRepairFiles = new RecordingReceiptFileOperations();
    const restartedEqualAdvance = new FileSessionForkReceiptStore(
      key => forkReceiptFile(state, key),
      uniqueIds('unused-equal-id'),
      equalRepairFiles,
    );
    await restartedEqualAdvance.advance(planPersisted);
    should(equalRepairFiles.calls).deepEqual([`read:${file}`, `sync-file:${file}`, `sync-directory:${forks}`]);
    should(parseSessionForkReceipt(JSON.parse(await readFile(file, 'utf8')), KEY).phase).equal('plan_persisted');
  });

  it('does not let a second first claim outrun the directory creator paused before parent sync', async () => {
    const home = await tempDirectory('fork-receipt-directory-race-sync');
    const state = join(home, 'state');
    const forks = join(state, 'forks');
    await mkdir(state, { recursive: true, mode: 0o700 });

    let enteredFirstParentSync!: () => void;
    const firstParentSyncEntered = new Promise<void>(resolve => {
      enteredFirstParentSync = resolve;
    });
    let releaseFirstParentSync!: () => void;
    const firstParentSyncReleased = new Promise<void>(resolve => {
      releaseFirstParentSync = resolve;
    });
    let parentSyncAttempts = 0;
    const files = new RecordingReceiptFileOperations(async path => {
      if (path !== state) return;
      parentSyncAttempts += 1;
      if (parentSyncAttempts !== 1) return;
      enteredFirstParentSync();
      await firstParentSyncReleased;
    });
    const subject = new FileSessionForkReceiptStore(key => forkReceiptFile(state, key), uniqueIds('a', 'b'), files);
    const file = forkReceiptFile(state, KEY);
    const aTemporary = `${file}.a.tmp`;
    const bTemporary = `${file}.b.tmp`;

    // A creates `forks` and pauses before syncing its entry in `state`. B sees an existing directory,
    // so only B's own mandatory parent sync can make it safe for B to publish and return.
    const a = subject.claim(claimedReceipt('target-a'));
    await firstParentSyncEntered;
    let b: unknown;
    let callsWhileCreatorPaused: readonly string[] = [];
    try {
      b = await subject.claim(claimedReceipt('target-b'));
      callsWhileCreatorPaused = [...files.calls];
    } finally {
      releaseFirstParentSync();
    }
    const adopted = await a;

    should((b as SessionForkReceipt).targetSessionId).equal('target-b');
    should(callsWhileCreatorPaused).deepEqual([
      `ensure:${forks}:${forks}`,
      `ensure:${forks}:existing`,
      `sync-directory:${state}`,
      `write-synced-closed:${bTemporary}`,
      `link:${bTemporary}->${file}`,
      `sync-directory:${forks}`,
      `discard:${bTemporary}`,
    ]);

    // Once A resumes it loses the link CAS, but it performs its own leaf sync before adopting B.
    should((adopted as SessionForkReceipt).targetSessionId).equal('target-b');
    should(files.calls).deepEqual([
      `ensure:${forks}:${forks}`,
      `ensure:${forks}:existing`,
      `sync-directory:${state}`,
      `write-synced-closed:${bTemporary}`,
      `link:${bTemporary}->${file}`,
      `sync-directory:${forks}`,
      `discard:${bTemporary}`,
      `sync-directory:${state}`,
      `write-synced-closed:${aTemporary}`,
      `link-refused:${aTemporary}->${file}`,
      `read:${file}`,
      `sync-file:${file}`,
      `sync-directory:${forks}`,
      `discard:${aTemporary}`,
    ]);
  });

  it('lets an EEXIST loser make the linked winner durable while that winner is paused before leaf sync', async () => {
    const home = await tempDirectory('fork-receipt-link-race-sync');
    const state = join(home, 'state');
    const forks = join(state, 'forks');
    await mkdir(forks, { recursive: true, mode: 0o700 });

    let enteredWinnerLeafSync!: () => void;
    const winnerLeafSyncEntered = new Promise<void>(resolve => {
      enteredWinnerLeafSync = resolve;
    });
    let releaseWinnerLeafSync!: () => void;
    const winnerLeafSyncReleased = new Promise<void>(resolve => {
      releaseWinnerLeafSync = resolve;
    });
    let leafSyncAttempts = 0;
    const files = new RecordingReceiptFileOperations(async path => {
      if (path !== forks) return;
      leafSyncAttempts += 1;
      if (leafSyncAttempts !== 1) return;
      enteredWinnerLeafSync();
      await winnerLeafSyncReleased;
    });
    const subject = new FileSessionForkReceiptStore(
      key => forkReceiptFile(state, key),
      uniqueIds('winner', 'loser'),
      files,
    );
    const file = forkReceiptFile(state, KEY);
    const winnerTemporary = `${file}.winner.tmp`;
    const loserTemporary = `${file}.loser.tmp`;

    const winning = subject.claim(claimedReceipt('target-a'));
    await winnerLeafSyncEntered;
    let adopted: unknown;
    let callsWhileWinnerPaused: readonly string[] = [];
    try {
      adopted = await subject.claim(claimedReceipt('target-b'));
      callsWhileWinnerPaused = [...files.calls];
    } finally {
      releaseWinnerLeafSync();
    }
    const winner = await winning;

    // The winner is still paused. The loser can safely return only because it performed its own
    // receipt-directory sync after EEXIST and before reading/adopting the visible winner.
    should((adopted as SessionForkReceipt).targetSessionId).equal('target-a');
    should(callsWhileWinnerPaused).deepEqual([
      `ensure:${forks}:existing`,
      `sync-directory:${state}`,
      `write-synced-closed:${winnerTemporary}`,
      `link:${winnerTemporary}->${file}`,
      `ensure:${forks}:existing`,
      `sync-directory:${state}`,
      `write-synced-closed:${loserTemporary}`,
      `link-refused:${loserTemporary}->${file}`,
      `read:${file}`,
      `sync-file:${file}`,
      `sync-directory:${forks}`,
      `discard:${loserTemporary}`,
    ]);

    should((winner as SessionForkReceipt).targetSessionId).equal('target-a');
    should(files.calls.slice(-2)).deepEqual([`sync-directory:${forks}`, `discard:${winnerTemporary}`]);
  });

  it('never overwrites or removes a foreign temporary when exclusive creation collides', async () => {
    const { subject, state, forks } = await harness('fork-receipt-temp-collision', {
      uniqueId: uniqueIds('foreign'),
    });
    await mkdir(forks, { recursive: true, mode: 0o700 });
    const file = forkReceiptFile(state, KEY);
    const temporary = `${file}.foreign.tmp`;
    await writeFile(temporary, 'another writer owns these bytes', { mode: 0o600 });

    await should(subject.claim(claimedReceipt())).be.rejectedWith(/EEXIST/u);
    should(await readFile(temporary, 'utf8')).equal('another writer owns these bytes');
    should(existsSync(file)).be.false();
  });
});

describe('FileSessionForkReceiptStore answers and repairs one pinned inode', () => {
  afterEach(async () => await cleanupTempDirectories());

  /**
   * Each of these unlinks the receipt name in the window between the bytes being read and that
   * handle being fsynced. A repair addressed by name would find nothing there and fail; a repair
   * that holds the handle persists exactly the inode whose bytes it answered with. The unlink stands
   * in for the real hazard — a concurrent publisher renaming a DIFFERENT inode onto the same name,
   * which would otherwise be sealed in place of the one that was read.
   */

  it('read answers from the pinned inode and seals it after its name is gone', async () => {
    const files = new RecordingReceiptFileOperations(
      undefined,
      once(async path => await unlink(path)),
    );
    const { subject, state, forks } = await harness('fork-receipt-read-pins-inode', {
      uniqueId: uniqueIds('claim'),
      files,
    });
    const file = forkReceiptFile(state, KEY);
    const claimed = claimedReceipt('target-pinned');
    await subject.claim(claimed);

    should(parseSessionForkReceipt(await subject.read(KEY), KEY)).deepEqual(claimed);
    should(existsSync(file)).be.false();
    should(files.calls.slice(-3)).deepEqual([`read:${file}`, `sync-file:${file}`, `sync-directory:${forks}`]);
  });

  it('an EEXIST loser adopts the winner from the pinned inode after its name is gone', async () => {
    const files = new RecordingReceiptFileOperations(
      undefined,
      once(async path => await unlink(path)),
    );
    const { subject, state, forks } = await harness('fork-receipt-adoption-pins-inode', {
      uniqueId: uniqueIds('winner', 'loser'),
      files,
    });
    const file = forkReceiptFile(state, KEY);
    const loserTemporary = `${file}.loser.tmp`;
    const winner = claimedReceipt('target-a');
    await subject.claim(winner);

    const adopted = await subject.claim(claimedReceipt('target-b'));

    should(parseSessionForkReceipt(adopted, KEY)).deepEqual(winner);
    should(existsSync(file)).be.false();
    should(files.calls.slice(-5)).deepEqual([
      `link-refused:${loserTemporary}->${file}`,
      `read:${file}`,
      `sync-file:${file}`,
      `sync-directory:${forks}`,
      `discard:${loserTemporary}`,
    ]);
  });

  it('an equal-phase replay is decided and repaired on the pinned inode, replacing no inode', async () => {
    const { subject, state, forks } = await harness('fork-receipt-replay-pins-inode');
    const claimed = claimedReceipt();
    await subject.claim(claimed);
    const targetCreated = advanceSessionForkReceipt(claimed, { phase: 'target_created', at: atFor('target_created') });
    await subject.advance(targetCreated);
    const file = forkReceiptFile(state, KEY);

    const files = new RecordingReceiptFileOperations(
      undefined,
      once(async path => await unlink(path)),
    );
    const replaying = new FileSessionForkReceiptStore(
      key => forkReceiptFile(state, key),
      uniqueIds('unused-replay-id'),
      files,
    );
    await replaying.advance(targetCreated);

    // Neither a private temporary nor a rename appears: the already-crossed boundary is repaired in
    // place, on the one inode the decision was read from.
    should(files.calls).deepEqual([`read:${file}`, `sync-file:${file}`, `sync-directory:${forks}`]);
    should(existsSync(file)).be.false();
  });
});

describe('NodeSessionForkReceiptFileOperations fsync refusals', () => {
  afterEach(async () => await cleanupTempDirectories());

  /** The production operations with their one fsync replaced by a filesystem's refusal. */
  function refusing(code: string): NodeSessionForkReceiptFileOperations {
    return new NodeSessionForkReceiptFileOperations(async () => {
      throw errno(code);
    });
  }

  it('tolerates exactly the directory refusals that mean the filesystem offers no directory fsync', async () => {
    const home = await tempDirectory('fork-receipt-directory-sync-tolerated');

    // A platform that cannot persist a directory entry must not fail every fork on this host.
    for (const code of ['EINVAL', 'ENOTSUP', 'EPERM']) {
      await refusing(code).syncDirectory(home);
    }

    // Every other refusal is a real failure and still stops the operation.
    for (const code of ['EIO', 'ENOSPC', 'EACCES', 'EBADF']) {
      await should(refusing(code).syncDirectory(home)).be.rejectedWith(`fsync refused with ${code}`);
    }
  });

  it('keeps a file fsync strict: the refusal a directory tolerates still fails a pinned read', async () => {
    const home = await tempDirectory('fork-receipt-file-sync-strict');
    const file = join(home, 'receipt.json');
    await writeFile(file, '{}', { mode: 0o600 });

    // Unpersisted receipt bytes are a lost receipt, so the same code is fatal here.
    await should(refusing('EINVAL').readPinned(file, async (_text, syncPinned) => await syncPinned())).be.rejectedWith(
      'fsync refused with EINVAL',
    );
  });

  it('keeps the private temporary write strict and removes the temporary it could not persist', async () => {
    const home = await tempDirectory('fork-receipt-temp-sync-strict');
    const temporary = join(home, 'receipt.json.tmp');

    await should(refusing('EPERM').writePrivateSynced(temporary, '{}', 0o600)).be.rejectedWith(
      'fsync refused with EPERM',
    );
    should(existsSync(temporary)).be.false();
  });

  it('discards best-effort, so a temporary that a rename already consumed is not an error', async () => {
    const home = await tempDirectory('fork-receipt-discard-consumed');
    const temporary = join(home, 'receipt.json.reused.tmp');

    // The store's cleanup relies on this: a name it no longer owns must not turn into a failure.
    await new NodeSessionForkReceiptFileOperations().discard(temporary);
    should(existsSync(temporary)).be.false();
  });

  it('surfaces a real open failure rather than answering it as a receipt that was never claimed', async () => {
    const home = await tempDirectory('fork-receipt-open-failure');
    const file = join(home, 'receipt.json');
    await writeFile(file, '{}', { mode: 0o600 });

    // Only ENOENT may be answered as "never claimed": a path that runs THROUGH a file is a broken
    // location, and reading it as unclaimed would let a retry mint a second target.
    await should(
      new NodeSessionForkReceiptFileOperations().readPinned(join(file, 'nested.json'), async () => undefined),
    ).be.rejectedWith(/ENOTDIR/u);
  });
});

describe('FileSessionForkReceiptStore claim (atomic compare-and-set)', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('writes the receipt at the daemon-global plan-id path and read returns it', async () => {
    const { subject, forks } = await harness('fork-receipt-claim');
    const claimed = claimedReceipt();

    // Act — the winner of an uncontested claim gets its own receipt back.
    should(await subject.claim(claimed)).deepEqual(claimed);
    should(await readdir(forks)).deepEqual([`${PLAN_ID}.json`]);

    // read returns the unparsed document, which round-trips to the exact receipt.
    should(await readParsed(subject)).deepEqual(claimed);
  });

  it('is a compare-and-set: a second claim adopts the holder and never overwrites it', async () => {
    const { subject } = await harness('fork-receipt-cas');
    const first = claimedReceipt('target-a');
    should(await subject.claim(first)).deepEqual(first);

    // A different reserved target under the same key: the store does NOT decide the conflict, it
    // answers with the holder so the orchestration can adopt the winner's target.
    const second = claimedReceipt('target-b');
    const adopted = await subject.claim(second);
    should(adopted).not.deepEqual(second);
    should((adopted as SessionForkReceipt).targetSessionId).equal('target-a');

    // The holder was never overwritten.
    should(await readParsed(subject)).deepEqual(first);
  });

  it('concurrent claims under one key resolve to one winner and one target, never two', async () => {
    const { subject, forks } = await harness('fork-receipt-concurrent');

    // Two claims race for the same key with different reserved targets.
    const [a, b] = await Promise.all([
      subject.claim(claimedReceipt('target-a')),
      subject.claim(claimedReceipt('target-b')),
    ]);

    // Exactly one receipt file exists, recording one target id.
    should(await readdir(forks)).deepEqual([`${PLAN_ID}.json`]);
    const onDisk = JSON.parse(await readFile(join(forks, `${PLAN_ID}.json`), 'utf8'));
    const winningTarget = onDisk.targetSessionId as string;
    should(['target-a', 'target-b']).containEql(winningTarget);

    // Both claims answer with the SAME holder: the loser adopted the winner rather than minting a
    // second target, which is what stops two attempts creating two sessions.
    should((a as SessionForkReceipt).targetSessionId).equal(winningTarget);
    should((b as SessionForkReceipt).targetSessionId).equal(winningTarget);
  });

  it('refuses to mint over a corrupt receipt, so a retry cannot create a second target', async () => {
    const { subject, forks } = await harness('fork-receipt-claim-corrupt');
    await subject.claim(claimedReceipt());
    await Bun.write(join(forks, `${PLAN_ID}.json`), '{ not a receipt');

    // A retry finds the pair already held; the claim must refuse rather than overwrite the anchor.
    await should(subject.claim(claimedReceipt())).be.rejectedWith(SessionForkReceiptInvalidError);
  });
});

describe('FileSessionForkReceiptStore advance (monotonic, never overwrites a mismatch)', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('crosses every phase monotonically and read reflects each boundary', async () => {
    const { subject } = await harness('fork-receipt-phases');
    let receipt = claimedReceipt();
    await subject.claim(receipt);

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

  it('refuses to move a receipt backwards to an earlier phase', async () => {
    const { subject } = await harness('fork-receipt-regression');
    // Drive the receipt forward to `imported`.
    let receipt = claimedReceipt();
    await subject.claim(receipt);
    for (const phase of ['target_created', 'plan_persisted'] as const) {
      receipt = advanceSessionForkReceipt(receipt, { phase, at: atFor(phase) });
      await subject.advance(receipt);
    }
    receipt = advanceSessionForkReceipt(receipt, { phase: 'imported', at: atFor('imported'), report: IMPORT_REPORT });
    await subject.advance(receipt);

    // A late, schema-valid `target_created` receipt is a regression against the `imported` one on disk.
    const late = advanceSessionForkReceipt(claimedReceipt(), { phase: 'target_created', at: atFor('target_created') });
    const error = await reject(subject.advance(late));
    should(error).be.instanceOf(SessionForkPhaseRegressionError);
  });

  it('refuses an advance for a different decision and leaves the frozen receipt intact', async () => {
    const { subject } = await harness('fork-receipt-advance-mismatch');
    const claimed = claimedReceipt('target-session');
    await subject.claim(claimed);

    // A different reserved target is a different decision: the full-decision fingerprint covers it.
    const differentTarget = claimedReceipt('other-target');
    const error = await reject(subject.advance(differentTarget));
    should(error).be.instanceOf(SessionForkReceiptInvalidError);
    should((await readParsed(subject)).targetSessionId).equal('target-session');
  });

  it('a replay of an advance that already landed leaves the receipt untouched', async () => {
    const { subject, forks } = await harness('fork-receipt-replay-same-phase');
    const claimed = claimedReceipt();
    await subject.claim(claimed);
    const atTargetCreated = advanceSessionForkReceipt(claimed, {
      phase: 'target_created',
      at: atFor('target_created'),
    });
    await subject.advance(atTargetCreated);
    const bytesAfterFirst = await readFile(join(forks, `${PLAN_ID}.json`), 'utf8');
    const inodeAfterFirst = (await stat(join(forks, `${PLAN_ID}.json`))).ino;

    // Re-advancing the same receipt is a no-op: the boundary is already crossed, so the file is untouched.
    await subject.advance(atTargetCreated);
    should((await readParsed(subject)).phase).equal('target_created');
    should(await readFile(join(forks, `${PLAN_ID}.json`), 'utf8')).equal(bytesAfterFirst);
    // Not merely identical bytes: the replay renamed nothing over the name, so it is the same inode.
    should((await stat(join(forks, `${PLAN_ID}.json`))).ino).equal(inodeAfterFirst);
  });

  it('refuses when no durable receipt holds the pair', async () => {
    const { subject } = await harness('fork-receipt-advance-unclaimed');
    await should(subject.advance(claimedReceipt())).be.rejectedWith(SessionForkReceiptInvalidError);
  });
});

describe('FileSessionForkReceiptStore refuses a corrupt or unknown durable anchor', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('read refuses a torn receipt file rather than treating it as unclaimed', async () => {
    const { subject, forks } = await harness('fork-receipt-torn');
    await subject.claim(claimedReceipt());
    await Bun.write(join(forks, `${PLAN_ID}.json`), '{ not a receipt');
    // A torn receipt must not read as undefined (which would trigger a fresh claim and a second target).
    await should(subject.read(KEY)).be.rejectedWith(SessionForkReceiptInvalidError);
  });

  it('advance refuses a receipt whose version it does not recognise', async () => {
    const { subject, forks } = await harness('fork-receipt-unknown-version');
    await Bun.write(join(forks, `${PLAN_ID}.json`), JSON.stringify({ v: 2 }));
    await should(subject.advance(claimedReceipt())).be.rejectedWith(SessionForkReceiptInvalidError);
  });
});

describe('FileSessionForkReceiptStore durability and source immutability', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('a fresh store instance reads the durable receipt and advances it without re-claiming', async () => {
    const { home } = await harness('fork-receipt-restart');
    const first = new FileSessionForkReceiptStore(key => forkReceiptFile(join(home, 'state'), key));
    const claimed = claimedReceipt();
    await first.claim(claimed);
    await first.advance(advanceSessionForkReceipt(claimed, { phase: 'target_created', at: atFor('target_created') }));

    // A new process, new store instance, same state tree.
    const restarted = new FileSessionForkReceiptStore(key => forkReceiptFile(join(home, 'state'), key));
    const held = parseSessionForkReceipt(await restarted.read(KEY), KEY);
    should(held.phase).equal('target_created');
    await restarted.advance(advanceSessionForkReceipt(held, { phase: 'plan_persisted', at: atFor('plan_persisted') }));
    should(parseSessionForkReceipt(await restarted.read(KEY), KEY).phase).equal('plan_persisted');
  });

  it('writes the receipt privately (0600) in a private directory (0700), leaving no temp behind', async () => {
    const { subject, forks } = await harness('fork-receipt-private');
    const claimed = claimedReceipt();
    await subject.claim(claimed);
    let receipt = claimed;
    for (const phase of SESSION_FORK_PHASES.slice(1) as readonly SessionForkPhase[]) {
      const report = phase === 'imported' ? IMPORT_REPORT : undefined;
      receipt = advanceSessionForkReceipt(receipt, { phase, at: atFor(phase), report });
      await subject.advance(receipt);
    }
    should(await readdir(forks)).deepEqual([`${PLAN_ID}.json`]);
    should((await stat(join(forks, `${PLAN_ID}.json`))).mode & 0o777).equal(0o600);
    should((await stat(forks)).mode & 0o777).equal(0o700);
  });

  it('never writes under or through the source session directory', async () => {
    const { subject, home } = await harness('fork-receipt-source-immutability');
    let receipt = claimedReceipt();
    await subject.claim(receipt);
    for (const phase of SESSION_FORK_PHASES.slice(1) as readonly SessionForkPhase[]) {
      const report = phase === 'imported' ? IMPORT_REPORT : undefined;
      receipt = advanceSessionForkReceipt(receipt, { phase, at: atFor(phase), report });
      await subject.advance(receipt);
    }
    // The source session directory was never created; only the daemon-global receipt exists.
    should(existsSync(join(home, 'sessions', SOURCE))).be.false();
    should(existsSync(join(home, 'state', 'forks', `${PLAN_ID}.json`))).be.true();
  });
});
