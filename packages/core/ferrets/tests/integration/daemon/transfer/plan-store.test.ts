import { afterEach, describe, it } from 'bun:test';
import { type FileHandle, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionTransferPlan } from '../../../../daemon/lib/protocol/session-transfer.ts';
import { SessionTransferPlanSchema } from '../../../../daemon/lib/protocol/session-transfer.ts';
import should from 'should';
import {
  FileSessionTransferTargetPlanStore,
  fsyncTransferPlanDirectory,
  fsyncTransferPlanFile,
  SessionTransferPlanConflictError,
  SessionTransferPlanCorruptError,
} from '../../../../daemon/adapters/transfer/plan-store.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { deriveTransferPlanId } from '../../../../daemon/lib/transfer/prepare.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The target-session plan copy, on a real filesystem: installed once and idempotently, refused when a
 * second plan claims the same target, written privately and atomically, and made durable parent-first.
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
  readonly subject: FileSessionTransferTargetPlanStore;
  readonly home: string;
}

async function harness(label: string): Promise<Harness> {
  const home = await tempDirectory(label);
  const subject = new FileSessionTransferTargetPlanStore(id => join(home, 'sessions', id, TARGET_PLAN_FILE), counter());
  return { subject, home };
}

describe('deriveTransferPlanId', () => {
  it('is deterministic in the (source session, request id) pair and nothing else', () => {
    should(deriveTransferPlanId(SOURCE, REQUEST)).equal(deriveTransferPlanId(SOURCE, REQUEST));
    should(deriveTransferPlanId(SOURCE, REQUEST)).not.equal(deriveTransferPlanId(SOURCE, 'req-2'));
    should(deriveTransferPlanId(SOURCE, REQUEST)).not.equal(deriveTransferPlanId('other-session', REQUEST));
    should(deriveTransferPlanId(SOURCE, REQUEST)).match(/^[0-9a-f]{64}$/);
  });
});

describe('FileSessionTransferTargetPlanStore install (target plan copy)', () => {
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

  it('surfaces a plan path that cannot be opened rather than reading it as no plan', async () => {
    // Arrange — a regular FILE where the target directory should be makes `open` fail with ENOTDIR,
    // a cause that holds for root as well (unlike a permission failure).
    const home = await tempDirectory('transfer-plan-unopenable');
    const target = parseSessionId('target-session');
    await mkdir(join(home, 'sessions'), { recursive: true });
    await writeFile(join(home, 'sessions', target), 'not a directory\n', 'utf8');
    const subject = new FileSessionTransferTargetPlanStore(
      id => join(home, 'sessions', id, TARGET_PLAN_FILE),
      counter(),
    );

    // Act
    const error = await reject(subject.install(target, makePlan({})));

    // Assert — only ENOENT means "no plan"; anything else must not be mistaken for it and overwritten.
    should((error as NodeJS.ErrnoException).code).equal('ENOTDIR');
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

describe('FileSessionTransferTargetPlanStore unreadable and corrupt documents', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('refuses a target plan document that is not valid JSON or not a valid plan, rather than reporting it absent', async () => {
    // Arrange
    const { subject } = await harness('transfer-target-plan-corrupt');
    const target = parseSessionId('20260806-target');
    const file = subject.targetPlanPath(target);
    await mkdir(dirname(file), { recursive: true });

    // Act + Assert
    await writeFile(file, '{ not json');
    await should(subject.load(target)).be.rejectedWith(SessionTransferPlanCorruptError);
    await writeFile(file, JSON.stringify({ v: 1 }));
    await should(subject.load(target)).be.rejectedWith(SessionTransferPlanCorruptError);
    await should(subject.install(target, makePlan({}))).be.rejectedWith(SessionTransferPlanCorruptError);
  });

  it('reports a target plan location that cannot be read as itself, not as an absent plan', async () => {
    // Arrange — the plan file's name is held by a directory.
    const { subject, home } = await harness('transfer-target-plan-unreadable');
    const target = parseSessionId('20260806-target');
    await mkdir(join(home, 'sessions', target, TARGET_PLAN_FILE), { recursive: true });

    // Act
    const error = await reject(subject.load(target));

    // Assert
    should((error as NodeJS.ErrnoException).code).equal('EISDIR');
  });
});
