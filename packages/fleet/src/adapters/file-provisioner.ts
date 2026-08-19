import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FleetManifestSchema } from '../lib/manifest.ts';
import {
  ABSENT_DOCUMENT_REVISION,
  type FleetApplyCommittedState,
  type FleetApplyFailure,
  FleetApplyFailureError,
  type FleetApplyPlan,
  type FleetApplyPreview,
  type FleetApplyResult,
  type FleetDocumentWrite,
  type FleetProvisioner,
  type FleetWriteOperation,
  type SettingsLayerSource,
} from '../lib/provisioning.ts';
import {
  mergeSettingsLayers,
  parseSettings,
  type SettingsFormat,
  type SettingsObject,
  serializeSettings,
} from '../lib/settings.ts';
import type { SharedHistoryMigration } from '../lib/shared-history.ts';
import { type FleetApplyLock, type FleetApplyLockOptions, fleetApplyLockFor } from './apply-lock.ts';
import { FileMutationJournal, isMutationReservedName, STAGE_PREFIX } from './mutation-journal.ts';

const CodexSqliteOriginalSchema = z.discriminatedUnion('present', [
  z.strictObject({ present: z.literal(false) }),
  z.strictObject({ present: z.literal(true), value: z.string() }),
]);

const CodexSqliteMarkerSchema = z.strictObject({
  version: z.literal(1),
  sqliteHome: z.string().min(1),
  createdConfig: z.boolean(),
  original: CodexSqliteOriginalSchema,
});

type CodexSqliteMarker = z.output<typeof CodexSqliteMarkerSchema>;

const MODE_BITS = 0o7777;

/**
 * Drop a staged replacement without ever becoming the reported failure.
 *
 * These run in a `finally`, on both the succeeding and the failing path. A throw here would replace
 * the error that actually caused the failure — leaving the caller to debug a cleanup instead of the
 * cause — or turn a published write into a spurious rollback. Leftovers carry a reserved prefix,
 * are skipped by the sweep, and are inert.
 */
async function discardQuietly(staged: string): Promise<void> {
  try {
    await rm(staged, { recursive: true, force: true });
  } catch {
    // Deliberately swallowed: see above.
  }
}

/** One entry an entry-by-entry publish brought into existence, and what proves it is still that. */
interface PublishedName {
  /** Relative to the publication root, `''` for the root itself, always with `/` separators. */
  readonly relative: string;
  readonly directory: boolean;
  /** `undefined` when no proof could be taken, which can never match and so never licenses a delete. */
  readonly identity: string | undefined;
}

/** Past this, a file is not proved by its content and is therefore never removed by a retract. */
const MAX_PUBLISH_DIGEST_BYTES = 4 * 1024 * 1024;

/**
 * Whether this operation enters its destination as a directory rather than replacing it.
 *
 * One predicate for the two places that ask, because they must agree: the preflight decides which
 * paths are inside the allowed roots and the mutation boundary rechecks the same question. A kind one
 * of them counted as a directory and the other did not would be approved and then refused. Every other
 * operation replaces or lstat-checks its final entry, so only its ancestors may be followed.
 */
const traversesDestination = (operation: FleetWriteOperation): boolean =>
  operation.kind === 'directory' || operation.kind === 'prune' || operation.kind === 'prune-directory';

/**
 * What proves an entry is the one this publish created.
 *
 * A directory is identified by inode alone. Its size and timestamps move every time a child is
 * added — including by this very publish, after the directory was recorded — so they cannot be
 * evidence about it. An addition inside it is caught instead by the entry set having to match
 * exactly, which is the stronger check anyway. A rename does not disturb an inode, so the
 * publication root still answers to this after being moved aside.
 *
 * A file is proved by its **content**, plus the stat fields that a `link` leaves alone — including
 * `uid` and `gid`, because a change of ownership is a change somebody made and is no more this
 * apply's to discard than a change of content. The inode cannot carry the proof on its own: the
 * published name and the staged name are the same inode, so anybody who writes through either one
 * changes what both of them say while the inode stays put. Hashing the bytes is what notices that.
 * `ctimeMs` and `nlink` are deliberately excluded — `link` moves both, so evidence taken before
 * publication would never match afterwards.
 *
 * A file too large to hash yields `undefined`: not knowing is not the same as knowing it is ours,
 * and the retract treats it as a reason to keep the tree rather than a reason to remove it.
 */
async function identityOf(target: string, information: Stats): Promise<string | undefined> {
  if (information.isDirectory()) return `dir:${information.dev}:${information.ino}`;
  if (information.size > MAX_PUBLISH_DIGEST_BYTES) return undefined;
  const digest = await contentProof(target, information.size);
  if (digest === undefined) return undefined;
  const { dev, ino, size, mtimeMs, mode, uid, gid } = information;
  return `file:${dev}:${ino}:${size}:${mtimeMs}:${mode}:${uid}:${gid}:${digest}`;
}

/**
 * Hash exactly the bytes the stat said were there, and refuse if the file turns out to differ.
 *
 * Reading the whole file by path would let the size check be bypassed: the bound is decided from a
 * stat, and a file that grows afterwards is read in full regardless, so the limit protects nothing
 * at the moment it matters. The read is instead done through one open handle into a buffer sized to
 * the figure that was checked, and then asked for one byte more. Anything past the buffer means the
 * file is not what the stat described — so nothing larger is ever allocated, and the mismatch is
 * reported as "no proof" rather than hashed into a digest of a file that changed while being read.
 *
 * A short read means it shrank, which is the same answer for the same reason.
 *
 * Opened without following the final component. The caller has already `lstat`ed this name, so a
 * link here is not the regular file whose identity was recorded — and following one would read
 * whatever it points at. Its identity would still mismatch on `dev:ino` and `mode`, so the deletion
 * decision stays fail-closed either way; what the no-follow prevents is the *read itself* going
 * somewhere it should not. A link aimed at a FIFO would otherwise block on open and turn a
 * mis-timed swap into a retract that never returns, which is a worse failure than a refusal.
 */
async function contentProof(target: string, size: number): Promise<string | undefined> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const { bytesRead } = await handle.read(bytes, filled, size - filled, filled);
      if (bytesRead === 0) return undefined;
      filled += bytesRead;
    }
    const beyond = await handle.read(Buffer.alloc(1), 0, 1, size);
    if (beyond.bytesRead !== 0) return undefined;
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  } finally {
    await handle.close();
  }
}

/**
 * Put the lock residue inside the committed state as well as on the error that carries it.
 *
 * A committed apply whose history migration then failed is the one failure that reports what the
 * host now *is*, and a claim nobody could clear is part of that: it blocks the next apply. The
 * residue only exists after the lock is released, which happens outside the boundary that built the
 * committed state, so the state is completed here rather than left with a field production could
 * never fill. Readers that show both the failure and the committed state print it once, comparing
 * the two.
 */
function withLockResidue(failure: FleetApplyFailure, lockResidue: string): FleetApplyFailure {
  if (failure.kind !== 'history-failed-after-commit') return failure;
  return { ...failure, committed: { ...failure.committed, lockResidue } };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A missing ancestor and an ancestor that is not a directory both end canonical resolution. */
function endsCanonicalResolution(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The canonical form of a directory, or of its nearest existing ancestor plus the missing tail. */
async function canonicalDirectory(directory: string): Promise<string> {
  const parent = path.dirname(directory);
  if (parent === directory) return directory;
  try {
    return await realpath(directory);
  } catch (error) {
    if (!endsCanonicalResolution(error)) throw error;
    return path.join(await canonicalDirectory(parent), path.basename(directory));
  }
}

/** Canonicalize every ancestor while leaving the final entry itself lexical. */
async function canonicalPath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(await canonicalDirectory(parent), path.basename(resolved));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Writes a plan to a real filesystem.
 *
 * Every path is checked against the roots the composition root declared, so a configuration cannot
 * talk this adapter into writing outside the directories the fleet owns. Files are written to a
 * temporary name and renamed, so a reader never observes a half-written wrapper or manifest. The
 * manifest is published after ordinary operations and before history migration: it records the
 * provisioned fleet even when a separate history migration subsequently fails.
 */
export class FileFleetProvisioner implements FleetProvisioner {
  private readonly allowedRoots: readonly string[];
  /** Tail of the serialized apply chain. Reads and previews are unaffected. */
  private queue: Promise<void> = Promise.resolve();
  constructor(
    allowedRoots: readonly string[],
    private readonly sharedHistory?: SharedHistoryMigration,
    private readonly lockOptions: FleetApplyLockOptions = {},
  ) {
    if (allowedRoots.length === 0) {
      throw new Error('at least one allowed fleet root is required');
    }
    this.allowedRoots = allowedRoots.map(root => path.resolve(root));
  }

  /**
   * Where the exclusive claim for this plan's fleet lives.
   *
   * Derived from the manifest, not from the allowed roots: the roots differ by caller — one
   * composition root declares the state home, another the fleet directory inside it — so a claim
   * keyed on them would give each caller its own lock and serialize nothing. Every caller plans
   * against the same `manifestPath`, so its directory is the one name they all agree on.
   */
  private lockFor(plan: FleetApplyPlan): FleetApplyLock {
    return fleetApplyLockFor(plan.manifestPath, this.lockOptions);
  }

  async preview(plan: FleetApplyPlan): Promise<FleetApplyPreview> {
    await this.preflightPlan(plan);
    const sharedHistory = await this.previewSharedHistory(plan);
    return {
      ...plan,
      operations: await this.previewOperations(plan.operations, sharedHistory),
      sharedHistory,
    };
  }

  /**
   * Materialize a plan, all of it or none of it.
   *
   * `documents` are written first and inside the same boundary, because a configuration edit and
   * the fleet it describes are only atomic together: a host left declaring an account whose home
   * was never created is precisely the half-state this method exists to rule out.
   *
   * The commit point is the manifest. Everything before it is undone on failure; the history
   * migration that follows has its own boundary and never rolls the fleet back, so a failure there
   * is reported as the different thing it is — a fleet that landed with a later step outstanding.
   */
  async apply(plan: FleetApplyPlan, documents: readonly FleetDocumentWrite[] = []): Promise<FleetApplyResult> {
    // One apply at a time per state home. Two overlapping applies capture each other's writes as
    // "the state before", so their rollbacks undo one another and neither report is true. The queue
    // orders callers inside this one object; the lock file orders this object against a separate
    // command-line invocation, which the queue alone cannot see.
    // Containment is decided before the claim, not after: the lock lives beside the manifest, so
    // taking it first would create a directory for a plan that is about to be refused for pointing
    // outside the allowed roots — the refusal would be correct and the host would still be changed.
    await this.assertWritablePath(plan.manifestPath);
    const lock = this.lockFor(plan);
    // The claim is a file this adapter creates, so it is held to the same containment as every
    // other write. Checking only the manifest would let a plan whose manifest sits inside the roots
    // still cause a lock file — and a directory for it — somewhere they do not.
    await this.assertWritablePath(lock.path);
    const guarded = async (): Promise<FleetApplyResult> => {
      const token = await lock.acquire();
      try {
        const result = await this.applyExclusively(plan, documents);
        const lockResidue = await lock.release(token);
        return lockResidue === undefined ? result : { ...result, lockResidue };
      } catch (error) {
        // The release runs either way, and its residue never changes what the apply was: a failed
        // apply that also leaked its lock is still that failure, now carrying one more fact.
        const lockResidue = await lock.release(token);
        if (lockResidue === undefined) throw error;
        if (error instanceof FleetApplyFailureError) {
          throw new FleetApplyFailureError(withLockResidue(error.failure, lockResidue), lockResidue);
        }
        // A refusal that never reached the rollback machinery still has to carry the residue, or a
        // leaked claim silently blocks every later apply with nothing said about it.
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; the exclusive apply claim at ${lockResidue} could not be cleared`,
          { cause: error },
        );
      }
    };
    const run = this.queue.then(guarded, guarded);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  private async applyExclusively(
    plan: FleetApplyPlan,
    documents: readonly FleetDocumentWrite[],
  ): Promise<FleetApplyResult> {
    await this.preflightApply(plan, documents);

    const journal = new FileMutationJournal(target => this.assertWritablePath(target));
    const prunedWrappers: string[] = [];
    let operationCount = 0;
    let stage = 'the configuration and asset documents';

    try {
      for (const document of documents) {
        const mark = journal.beginOperation();
        await this.writeDocument(document, journal);
        await journal.sealOperation(mark);
      }

      for (const operation of plan.operations) {
        stage = `${operation.kind} ${operation.path}`;
        // Recheck at the mutation boundary as well: an earlier operation must not be able to
        // replace an ancestor with a link after the all-or-nothing preflight approved this
        // destination.
        await this.assertOperationWritable(operation);
        const mark = journal.beginOperation();
        const pruned = await this.applyOperation(operation, journal);
        await journal.sealOperation(mark);
        if (pruned === undefined) continue;
        operationCount += 1;
        prunedWrappers.push(...pruned);
      }

      stage = `the fleet manifest ${plan.manifestPath}`;
      const mark = journal.beginOperation();
      await this.writeManifest(plan, journal);
      await journal.sealOperation(mark);
    } catch (error) {
      throw await this.rollback(journal, stage, error);
    }

    // Committed. Cleanup from here is best-effort and never reclassifies a successful apply.
    const backupResidue = await journal.discard();
    const residue = backupResidue.length === 0 ? {} : { backupResidue };

    const committed = (sharedHistory: FleetApplyPreview['sharedHistory']): FleetApplyCommittedState => ({
      accountCount: plan.manifest.accounts.length,
      operationCount,
      manifestPath: plan.manifestPath,
      manifest: plan.manifest,
      prunedWrappers,
      sharedHistory,
      ...residue,
    });

    const sharedHistory = [];
    for (const request of plan.sharedHistoryRequests ?? []) {
      try {
        sharedHistory.push(await this.sharedHistoryMigration().materialize(request));
      } catch (error) {
        throw new FleetApplyFailureError({
          kind: 'history-failed-after-commit',
          failedHarness: request.kind,
          reason: error instanceof Error ? error.message : String(error),
          committed: committed(sharedHistory),
        });
      }
    }

    return {
      accountCount: plan.manifest.accounts.length,
      operationCount,
      manifestPath: plan.manifestPath,
      prunedWrappers,
      sharedHistory,
      ...residue,
    };
  }

  /** Undo the batch and classify what the host is now, which is the only thing a caller can act on. */
  private async rollback(journal: FileMutationJournal, stage: string, error: unknown): Promise<Error> {
    const { unrestored, displaced } = await journal.rollback();
    const reason = error instanceof Error ? error.message : String(error);
    // "Rolled back" is a claim about the host, not about the fleet: anything of somebody else's
    // that had to be moved out of the way leaves a renamed path and a reserved file behind, so it
    // belongs with the incomplete outcomes however cleanly the fleet itself reverted.
    if (unrestored.length === 0 && displaced.length === 0) {
      return new FleetApplyFailureError({ kind: 'rolled-back', failedOperation: stage, reason });
    }
    return new FleetApplyFailureError({
      kind: 'rollback-incomplete',
      failedOperation: stage,
      reason,
      unrestored,
      ...(displaced.length === 0 ? {} : { displaced }),
    });
  }

  private async writeDocument(document: FleetDocumentWrite, journal: FileMutationJournal): Promise<void> {
    await this.assertWritablePath(document.path);
    await journal.captureDirectory(path.dirname(document.path));
    await journal.capture(document.path);
    // Checked here and nowhere earlier. The capture has already renamed whatever was at the path
    // out of everyone's reach, so what it moved aside is exactly what this write is replacing and
    // the answer cannot go stale between the question and the write. A check made before the
    // capture leaves a window in which the host is edited and the edit is silently overwritten.
    //
    // Unconditional, deliberately: a write that expected to find a file and finds nothing is a
    // write whose author never saw the deletion, and recreating the file would silently undo it.
    if (document.expect !== undefined) await this.assertExpected(document, journal);
    await mkdir(path.dirname(document.path), { recursive: true });
    await this.writeFileAtomically(document.path, document.content, document.mode, journal);
  }

  private async assertExpected(document: FleetDocumentWrite, journal: FileMutationJournal): Promise<void> {
    const backup = journal.backupOf(document.path);
    const found =
      backup === undefined
        ? ABSENT_DOCUMENT_REVISION
        : new Bun.CryptoHasher('sha256').update(await readFile(backup)).digest('hex');
    if (found === document.expect) return;
    throw new Error(
      `refusing to write ${document.path}: it is not what this change was composed against, so applying would discard the newer version`,
    );
  }

  /** Validate the published record before preview returns or apply performs its first write. */
  private async preflightPlan(plan: FleetApplyPlan): Promise<void> {
    FleetManifestSchema.parse(plan.manifest);
    await this.assertWritablePath(plan.manifestPath);
  }

  /** Validate every write before apply performs its first one. */
  private async preflightApply(plan: FleetApplyPlan, documents: readonly FleetDocumentWrite[]): Promise<void> {
    await this.preflightPlan(plan);
    const sharedHistory = await this.previewSharedHistory(plan);
    this.assertNoSharedHistoryRefusals(sharedHistory);
    for (const document of documents) await this.assertWritablePath(document.path);
    for (const operation of plan.operations) await this.assertOperationWritable(operation);
    // Reading every input here — not at the operation that consumes it — is what turns a whole
    // class of mid-apply failures into a refusal that never touched the host. It also closes a
    // data-loss hole: a copy used to clear its destination and only then discover its source.
    await this.previewOperations(plan.operations, sharedHistory);
    await this.validateOperationInputs(plan.operations, documents);
  }

  /**
   * Prove every source an operation will read is present and usable. Nothing is written and nothing
   * is destroyed, so a configuration naming a missing asset or an unparseable settings layer is
   * refused with the host exactly as it was.
   *
   * A source THIS APPLY WRITES is proved from the document rather than from the disk. Documents are
   * written first and inside the same boundary, so by the time the operation runs the file is there —
   * and a document write that failed aborts before any operation. Statting it here would refuse a
   * change whose whole point is to create the asset it then copies: giving one account its own copy of
   * a shared instructions file writes the copy and copies it into that account's home, in one apply.
   */
  private async validateOperationInputs(
    operations: readonly FleetWriteOperation[],
    documents: readonly FleetDocumentWrite[],
  ): Promise<void> {
    const pending = new Map(documents.map(document => [path.resolve(document.path), document.content]));
    for (const operation of operations) {
      if (operation.kind === 'copy') {
        if (!pending.has(path.resolve(operation.source))) await stat(operation.source);
        continue;
      }
      if (operation.kind !== 'settings') continue;
      for (const layer of operation.layers) {
        if (layer.from === 'inline') continue;
        const written = pending.get(path.resolve(layer.path));
        parseSettings(written ?? (await readFile(layer.path, 'utf8')), operation.format);
      }
    }
  }

  /** A partly observed history request must refuse before any ordinary or history mutation lands. */
  private assertNoSharedHistoryRefusals(previews: FleetApplyPreview['sharedHistory']): void {
    for (const preview of previews) {
      const refusals = preview.refusals ?? [];
      if (refusals.length === 0) continue;
      throw new Error(
        `refusing to migrate ${preview.kind} history while ${refusals.length} account home(s) cannot be read: ${refusals
          .map(refusal => `${refusal.account} (${refusal.home}): ${refusal.reason}`)
          .join('; ')}`,
      );
    }
  }

  private async assertOperationWritable(operation: FleetWriteOperation): Promise<void> {
    await this.assertWritablePath(operation.path, traversesDestination(operation));
    if (operation.kind === 'codex-sqlite-ownership') await this.assertWritablePath(operation.markerPath);
  }

  /**
   * A disabled ownership operation is intentionally present in the pure plan: a sidecar from an
   * earlier enable is the only authority to restore or remove `sqlite_home`. Preview may omit that
   * operation only after observing that no sidecar exists. Existing evidence is parsed, along with
   * the config it governs, so damaged state is refused now rather than advertised as a clean plan.
   */
  private async previewOperations(
    operations: readonly FleetWriteOperation[],
    sharedHistory: FleetApplyPreview['sharedHistory'],
  ): Promise<readonly FleetWriteOperation[]> {
    const refusedHomes = sharedHistory.flatMap(preview => (preview.refusals ?? []).map(refusal => refusal.home));
    const previewed: FleetWriteOperation[] = [];
    for (const operation of operations) {
      const followsFinalComponent = traversesDestination(operation);
      const pathWritable = await this.isWritablePath(operation.path, followsFinalComponent);
      if (!pathWritable && !this.isRepresentedByRefusedHome(operation.path, refusedHomes)) {
        throw new Error(`refusing to write outside configured fleet roots: ${operation.path}`);
      }

      if (operation.kind !== 'codex-sqlite-ownership') {
        previewed.push(operation);
        continue;
      }

      const markerWritable = await this.isWritablePath(operation.markerPath);
      if (!markerWritable && !this.isRepresentedByRefusedHome(operation.markerPath, refusedHomes)) {
        throw new Error(`refusing to write outside configured fleet roots: ${operation.markerPath}`);
      }

      // Shared-history preview turns an out-of-root account home into structured, renderable
      // evidence. Only paths lexically beneath that exact refused home inherit the evidence; keep
      // their ownership operation visible, but never inspect files outside the declared roots.
      if (!pathWritable || !markerWritable) {
        previewed.push(operation);
        continue;
      }

      const markerDocument = await this.readRegularText(operation.markerPath, 'Codex SQLite ownership sidecar');
      const marker =
        markerDocument === undefined ? undefined : this.parseCodexSqliteMarker(markerDocument, operation.markerPath);
      if (!operation.enabled && marker === undefined) continue;

      const configDocument = await this.readRegularText(operation.path, 'Codex configuration');
      const current =
        configDocument === undefined
          ? {}
          : this.parseCodexConfig(
              configDocument,
              operation.path,
              operation.enabled ? 'enabling sharing' : 'disabling sharing',
            );
      if (operation.enabled && marker === undefined) this.sqliteHomeState(current, operation.path);
      previewed.push(operation);
    }
    return previewed;
  }

  private isRepresentedByRefusedHome(target: string, refusedHomes: readonly string[]): boolean {
    const resolved = path.resolve(target);
    return refusedHomes.some(home => isInside(path.resolve(home), resolved));
  }

  private async previewSharedHistory(plan: FleetApplyPlan): Promise<FleetApplyPreview['sharedHistory']> {
    if ((plan.sharedHistoryRequests?.length ?? 0) === 0) return [];
    const migration = this.sharedHistoryMigration();
    const previews = [];
    for (const request of plan.sharedHistoryRequests ?? []) previews.push(await migration.preview(request));
    return previews;
  }

  private sharedHistoryMigration(): SharedHistoryMigration {
    if (this.sharedHistory === undefined) {
      throw new Error('shared-history operations were planned without a shared-history filesystem adapter');
    }
    return this.sharedHistory;
  }

  /**
   * A root is inside itself. `path.relative(root, root)` is the empty string, so requiring a
   * non-empty result rejected the one directory every first run has to create — the fleet root — and
   * `fy fleet init` followed by `fy fleet apply` failed on any fresh host, even with `agents: []`.
   * The empty string satisfies every escape test below on its own; only the length check excluded it.
   */
  private async assertWritablePath(target: string, followFinalComponent = false): Promise<void> {
    if (!(await this.isWritablePath(target, followFinalComponent))) {
      throw new Error(`refusing to write outside configured fleet roots: ${target}`);
    }
  }

  private async isWritablePath(target: string, followFinalComponent = false): Promise<boolean> {
    const canonical = followFinalComponent
      ? await canonicalDirectory(path.resolve(target))
      : await canonicalPath(target);
    const roots = await Promise.all(this.allowedRoots.map(canonicalDirectory));
    return roots.some(root => isInside(root, canonical));
  }

  /** Returns pruned names, or `undefined` when filesystem evidence proves the operation a no-op. */
  private async applyOperation(
    operation: FleetWriteOperation,
    journal: FileMutationJournal,
  ): Promise<readonly string[] | undefined> {
    if (operation.kind === 'directory') {
      await journal.captureDirectory(operation.path, operation.mode);
      await mkdir(operation.path, { recursive: true, mode: operation.mode });
      if (operation.mode !== undefined) {
        await chmod(operation.path, operation.mode);
      }
      return [];
    }

    if (operation.kind === 'prune') {
      return await this.prune(operation.path, operation.marker, new Set(operation.keep), journal);
    }

    if (operation.kind === 'prune-directory') {
      await this.pruneDirectory(operation.path, new Set(operation.keep), journal);
      // Deliberately no names: the caller collects what it reports as pruned WRAPPERS, and a removed
      // skill item is not one. What was removed is visible where a person decides — the dry run states
      // the directory and the keep set it is bounded to.
      return [];
    }

    if (operation.kind === 'codex-sqlite-ownership') {
      return (await this.reconcileCodexSqliteOwnership(operation, journal)) ? [] : undefined;
    }

    if (operation.kind === 'settings') {
      await journal.captureDirectory(path.dirname(operation.path));
      // Clear the path only when this batch already owned it. After a fresh capture the path is
      // empty, and anything that has appeared since belongs to somebody else — the publishing link
      // then fails with EEXIST rather than silently replacing their file.
      if (!(await journal.capture(operation.path))) await rm(operation.path, { recursive: true, force: true });
      // Resolved from what the capture moved aside, not from the live path before it. Reading the
      // live path first left a window in which a harness wrote a runtime key, the capture then
      // moved that newer file away, and the merge — computed from the older one — discarded it.
      // The backup cannot change under this read, so the keys folded in are exactly the keys that
      // were there when this operation took ownership of the destination.
      const content = await this.resolveSettings(journal.backupOf(operation.path), operation.format, operation.layers, {
        preserveExisting: operation.preserveExisting,
      });
      await mkdir(path.dirname(operation.path), { recursive: true });
      await this.writeFileAtomically(operation.path, content, operation.mode, journal);
      return [];
    }

    await journal.captureDirectory(path.dirname(operation.path));
    await mkdir(path.dirname(operation.path), { recursive: true });

    if (operation.kind === 'symlink') {
      // Clear the path only when this batch already owned it. After a fresh capture the path is
      // empty, and anything that has appeared since belongs to somebody else: letting `symlink`
      // fail with EEXIST surfaces that as a refusal instead of deleting their work.
      if (!(await journal.capture(operation.path))) await rm(operation.path, { recursive: true, force: true });
      await symlink(operation.source, operation.path);
      return [];
    }

    if (operation.kind === 'copy') {
      // Profile assets may be files or directories. Dereference every source link: a copied account
      // home must not reintroduce a symlink beneath FY_HOME, where StateFileSystem deliberately
      // rejects symlink components to prevent an operation escaping its state-home boundary.
      const source = await stat(operation.source);
      // Built beside the destination, so publishing it never crosses a device. Staging is what keeps
      // a *half-copied* tree from ever being live: the copy either completes into the staged name or
      // fails there, and the destination survives untouched either way. It is not what makes the
      // publish itself atomic — see `publish`, which materialises a directory entry by entry with
      // exclusive primitives and unwinds exactly what it created if it cannot finish.
      const staged = path.join(path.dirname(operation.path), `${STAGE_PREFIX}${randomUUID()}`);
      try {
        await cp(operation.source, staged, { recursive: source.isDirectory(), dereference: true });
        // A template linked out of a read-only store copies as 0444; force the copied root writable
        // so a harness can rewrite a file it owns. Directories remain private to the account.
        await chmod(staged, operation.mode ?? (source.isDirectory() ? 0o700 : 0o644));
        if (!(await journal.capture(operation.path))) await rm(operation.path, { recursive: true, force: true });
        await this.publish(staged, operation.path, journal);
      } finally {
        await discardQuietly(staged);
      }
      return [];
    }

    await journal.capture(operation.path);
    await this.writeFileAtomically(operation.path, operation.content, operation.mode, journal);
    return [];
  }

  /**
   * Capture or remove Ferretry's exact `sqlite_home` override. The sidecar is written before the
   * settings operation which injects the value, so an interrupted enable still has enough evidence
   * for a later disable. Disable restores only when the current value still equals the one recorded
   * by our sidecar; a user replacement is left untouched.
   */
  private async reconcileCodexSqliteOwnership(
    operation: Extract<FleetWriteOperation, { readonly kind: 'codex-sqlite-ownership' }>,
    journal: FileMutationJournal,
  ): Promise<boolean> {
    await this.assertWritablePath(operation.markerPath);
    const markerDocument = await this.readRegularText(operation.markerPath, 'Codex SQLite ownership sidecar');
    const marker =
      markerDocument === undefined ? undefined : this.parseCodexSqliteMarker(markerDocument, operation.markerPath);

    if (operation.enabled) {
      const configDocument = await this.readRegularText(operation.path, 'Codex configuration');
      const current =
        configDocument === undefined ? {} : this.parseCodexConfig(configDocument, operation.path, 'enabling sharing');
      const next: CodexSqliteMarker = {
        version: 1,
        sqliteHome: operation.sqliteHome,
        createdConfig: marker?.createdConfig ?? configDocument === undefined,
        original: marker?.original ?? this.sqliteHomeState(current, operation.path),
      };
      await journal.captureDirectory(path.dirname(operation.markerPath), 0o700);
      await journal.capture(operation.markerPath);
      await mkdir(path.dirname(operation.markerPath), { recursive: true, mode: 0o700 });
      await this.writeFileAtomically(operation.markerPath, `${JSON.stringify(next)}\n`, 0o600, journal);
      return true;
    }

    if (marker === undefined) return false;
    const configDocument = await this.readRegularText(operation.path, 'Codex configuration');
    if (configDocument !== undefined) {
      const current = { ...this.parseCodexConfig(configDocument, operation.path, 'disabling sharing') };
      if (current.sqlite_home === marker.sqliteHome) {
        if (marker.original.present) current.sqlite_home = marker.original.value;
        else delete current.sqlite_home;
        await journal.capture(operation.path);
        if (!(marker.createdConfig && Object.keys(current).length === 0)) {
          await this.writeFileAtomically(operation.path, serializeSettings(current, 'toml'), 0o600, journal);
        }
      }
    }
    await journal.capture(operation.markerPath);
    return true;
  }

  private async readRegularText(target: string, label: string): Promise<string | undefined> {
    let information: Awaited<ReturnType<typeof lstat>>;
    try {
      information = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!information.isFile()) throw new Error(`${label} must be a regular file: ${target}`);
    return await readFile(target, 'utf8');
  }

  private parseCodexSqliteMarker(document: string, markerPath: string): CodexSqliteMarker {
    let parsed: unknown;
    try {
      parsed = JSON.parse(document);
    } catch (error) {
      throw new Error(`cannot safely reconcile Codex SQLite ownership sidecar ${markerPath}: ${String(error)}`);
    }
    const marker = CodexSqliteMarkerSchema.safeParse(parsed);
    if (!marker.success || !path.isAbsolute(marker.data.sqliteHome)) {
      throw new Error(`cannot safely reconcile invalid Codex SQLite ownership sidecar: ${markerPath}`);
    }
    return marker.data;
  }

  private parseCodexConfig(document: string, configPath: string, phase: string): SettingsObject {
    try {
      return parseSettings(document, 'toml');
    } catch (error) {
      throw new Error(`cannot parse Codex configuration while ${phase}: ${configPath}: ${String(error)}`);
    }
  }

  private sqliteHomeState(settings: SettingsObject, configPath: string): CodexSqliteMarker['original'] {
    if (!Object.hasOwn(settings, 'sqlite_home')) return { present: false };
    if (typeof settings.sqlite_home !== 'string') {
      throw new Error(`existing sqlite_home must be a string before sharing can change it: ${configPath}`);
    }
    return { present: true, value: settings.sqlite_home };
  }

  /**
   * Remove managed files in `directory` that nothing claims any more. Bounded twice: only direct
   * children, and only files whose text carries `marker`. A symlink, a subdirectory, or a file the
   * user wrote by hand is never touched, so an unrelated executable on the same `PATH` directory
   * survives.
   */
  private async prune(
    directory: string,
    marker: string,
    keep: ReadonlySet<string>,
    journal: FileMutationJournal,
  ): Promise<readonly string[]> {
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch {
      return [];
    }

    const pruned: string[] = [];
    for (const entry of entries.toSorted()) {
      if (keep.has(entry)) continue;
      // A backup of a managed wrapper still carries the managed marker. Sweeping it away would
      // destroy the only copy of what this very batch may still need to put back. One predicate
      // covers every reserved prefix, so a prefix added later is skipped here without this line
      // having to be found and widened.
      if (isMutationReservedName(entry)) continue;
      const target = path.join(directory, entry);
      const stats = await lstat(target);
      if (!stats.isFile()) continue;
      // An unreadable file inside a directory the fleet created at 0700 is an anomaly, and
      // swallowing it would leave a stale wrapper on PATH with nothing said about it.
      const content = await readFile(target, 'utf8');
      if (!content.includes(marker)) continue;
      await journal.capture(target);
      // The decision was made from the file as it was read; the capture moved aside the file as it
      // is now. If something replaced it in between, what was moved aside is not what this sweep
      // agreed to remove — and putting it back by hand would replace the newcomer in turn. So the
      // apply fails here and the rollback decides: it restores only where the name is still free,
      // and otherwise keeps the backup and reports the path as unrestored.
      if (!(await this.stillCarries(journal.backupOf(target), marker))) {
        throw new Error(`refusing to prune ${target}: it changed between being read and being removed`);
      }
      pruned.push(entry);
    }
    return pruned;
  }

  /**
   * Empty a directory the fleet materialized entry by entry of everything this plan did not put there.
   *
   * Bounded to direct children and to the keep list, and — unlike {@link prune} — it removes
   * directories as well as files, because the entries here ARE directories: one skill item is a tree.
   * There is no marker to check for the same reason, and the bound that replaces it is ownership: this
   * destination was replaced wholesale by every apply before the field became per-item, so nothing a
   * user placed here has ever survived one.
   *
   * Removal goes through the journal like every other destructive step, so a later failure in the same
   * batch puts each swept entry back exactly where it was.
   */
  private async pruneDirectory(
    directory: string,
    keep: ReadonlySet<string>,
    journal: FileMutationJournal,
  ): Promise<void> {
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }

    for (const entry of entries.toSorted()) {
      if (keep.has(entry)) continue;
      // A backup or staging name belongs to this very batch; sweeping one away would destroy the only
      // copy of what a rollback needs to put back.
      if (isMutationReservedName(entry)) continue;
      // capture() renames the entry aside and records the restore. It reports false only when this
      // batch already captured the path, which cannot happen here: every path this plan writes under
      // the container is in the keep set.
      await journal.capture(path.join(directory, entry));
    }
  }

  private async stillCarries(backup: string | undefined, marker: string): Promise<boolean> {
    if (backup === undefined) return false;
    const stats = await lstat(backup);
    if (!stats.isFile()) return false;
    return (await readFile(backup, 'utf8')).includes(marker);
  }

  private async resolveSettings(
    previous: string | undefined,
    format: SettingsFormat,
    layers: readonly SettingsLayerSource[],
    options: { readonly preserveExisting: boolean },
  ): Promise<string> {
    const resolved: SettingsObject[] = [];
    if (options.preserveExisting && previous !== undefined) {
      const existing = await this.readExistingSettings(previous, format);
      if (existing !== undefined) resolved.push(existing);
    }
    for (const layer of layers) {
      resolved.push(
        layer.from === 'inline' ? layer.settings : parseSettings(await readFile(layer.path, 'utf8'), format),
      );
    }
    return serializeSettings(mergeSettingsLayers(resolved), format);
  }

  /**
   * The file the harness has been writing to, folded back in as the base layer so a re-apply keeps
   * runtime keys. A symlink holds only template content and an unparseable file holds nothing that
   * can be merged, so both yield nothing rather than failing the apply.
   */
  private async readExistingSettings(destination: string, format: SettingsFormat): Promise<SettingsObject | undefined> {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(destination);
    } catch (error) {
      // Absent is the ordinary first-apply case and carries nothing to preserve.
      if (isMissing(error)) return undefined;
      throw error;
    }
    // A symlink is the one justified exception: it holds template content the assets directory is
    // the authority for, not runtime keys, so there is nothing of the person's in it to lose.
    // Everything else is fail-closed. A settings file that cannot be read or parsed — and a
    // directory or a device node where one should be — is state this apply is about to replace with
    // a merge computed without it, and silently discarding somebody's configuration because it was
    // damaged is the worst of the available answers. Refusing leaves it where it is, to be looked at.
    if (stats.isSymbolicLink()) return undefined;
    if (!stats.isFile()) {
      throw new Error(`refusing to merge settings over ${destination}: it is not a regular file`);
    }
    let document: string;
    try {
      document = await readFile(destination, 'utf8');
    } catch (error) {
      throw new Error(`refusing to merge settings over ${destination}: it could not be read (${reasonOf(error)})`);
    }
    try {
      return parseSettings(document, format);
    } catch (error) {
      throw new Error(`refusing to merge settings over ${destination}: it could not be parsed (${reasonOf(error)})`);
    }
  }

  private async writeManifest(plan: FleetApplyPlan, journal: FileMutationJournal): Promise<void> {
    await this.assertWritablePath(plan.manifestPath);
    const content = `${JSON.stringify(plan.manifest, null, 2)}\n`;
    await journal.captureDirectory(path.dirname(plan.manifestPath));
    await journal.capture(plan.manifestPath);
    await mkdir(path.dirname(plan.manifestPath), { recursive: true });
    await this.writeFileAtomically(plan.manifestPath, content, 0o600, journal);
  }

  private async writeFileAtomically(
    destination: string,
    content: string,
    mode: number,
    journal: FileMutationJournal,
  ): Promise<void> {
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx', mode });
      await chmod(temporary, mode);
      await this.publish(temporary, destination, journal);
    } finally {
      await discardQuietly(temporary);
    }
  }

  /**
   * Move a staged entry into its final name, refusing rather than overwriting.
   *
   * Every destination is captured before this runs, so the name is free and `link` succeeds. If it
   * does not, something arrived in the window between the capture and the publish — and a rename,
   * which would silently replace it, is exactly the wrong answer. Directories cannot be linked and
   * have no no-replace rename either, so a staged tree is not renamed at all: it is materialised
   * entry by entry with primitives that are exclusive at every level, and unwound if it cannot be
   * finished. See the comment on that branch below.
   */
  private async publish(staged: string, destination: string, journal: FileMutationJournal): Promise<void> {
    const information = await lstat(staged);
    if (!information.isDirectory()) {
      // `link` is the no-replace primitive: it fails rather than overwriting, so a destination that
      // reappeared between the capture and here is refused instead of silently replaced.
      await link(staged, destination);
      await rm(staged, { force: true });
      return;
    }
    // A directory has no no-replace rename: `rename` will happily replace an empty one, taking its
    // inode, mode and ownership with it, and a check beforehand only narrows the window rather than
    // closing it. So the tree is published with primitives that are exclusive at every level —
    // non-recursive `mkdir` for each directory, `link` for each file — and any name already taken
    // fails rather than being overwritten.
    //
    // The trade is that the tree becomes visible entry by entry instead of all at once, so a failure
    // part-way through leaves a half-materialised account that has to be taken back out again.
    const created: PublishedName[] = [];
    try {
      await this.publishTree(staged, destination, information.mode & MODE_BITS, created, '');
    } catch (error) {
      await this.retractPublication(destination, created, journal);
      throw error;
    }
    await rm(staged, { recursive: true, force: true });
  }

  /**
   * Take a half-published tree back out, without ever deleting anything at a live path.
   *
   * The obvious version — walk the recorded names and unlink each one — cannot be made safe. Even
   * re-identifying each entry first leaves the gap between the check and the removal, and a writer
   * who replaces our file in that gap has their replacement deleted by a decision made about our
   * bytes. Narrowing that window is not closing it.
   *
   * So nothing is deleted by name. The publication root is renamed out of the live tree in one
   * atomic step, taking the whole partial tree with it — including anything a writer added inside
   * it, which travels along rather than being destroyed. Afterwards the tree is unreachable to
   * anybody resolving the old pathname, so the comparison that decides its fate is a comparison of
   * something no new writer can arrive at. Only a tree that is still *exactly* this publish's own
   * work is destroyed; anything else is kept and reported as displaced, which lands the apply on
   * `rollback-incomplete` with the location named.
   *
   * **The residual is an open descriptor, and it is not claimed away.** A process holding a file or
   * directory handle opened before the rename keeps it afterwards and can still write through it, so
   * a tree that passed verification can be modified between the verdict and the removal. Renaming
   * closes the pathname race this code is responsible for; nothing available here closes that one.
   * The verification is made as strong as the evidence allows — every entry accounted for, each
   * still carrying the size, timestamps and mode it was published with — so an edit that landed
   * before the check is caught even though one landing after it is not.
   *
   * Two consequences are deliberate. The destination is left free either way, so the journal can
   * rename the account's original content back into place — and if a writer creates something new
   * there first, that restore refuses and is reported rather than overwriting them. And a failure to
   * displace at all is swallowed: this runs while an apply is already failing, and replacing that
   * failure with a cleanup error would hide the cause. The half-published tree then simply stays,
   * which blocks the restore and is reported as unrestored.
   */
  private async retractPublication(
    destination: string,
    created: readonly PublishedName[],
    journal: FileMutationJournal,
  ): Promise<void> {
    try {
      await journal.displace(destination, async moved => await this.isExactlyPublished(moved, created));
    } catch {
      // Deliberately swallowed: see above. The tree stays, and the journal reports the destination.
    }
  }

  /**
   * Whether a displaced tree is precisely what this publish put there — no more, no less.
   *
   * Every entry has to be one this publish created, still carrying the identity it was recorded
   * with, and every entry it created has to be present. An addition fails the first test, a
   * replacement or an in-place edit fails the second, and a deletion fails the third. Anything this
   * cannot account for is a reason to keep the tree, never to remove it.
   *
   * The content is read here, from the tree's new location. That is not the live path — the rename
   * happened first, and nobody resolving the destination reaches these bytes any more — so unlike a
   * check made before the move, this one is not answering a question about somebody else's file.
   */
  private async isExactlyPublished(moved: string, created: readonly PublishedName[]): Promise<boolean> {
    const expected = new Map(created.map(entry => [entry.relative, entry]));
    let matched = 0;

    const account = async (target: string, relative: string): Promise<boolean> => {
      const entry = expected.get(relative);
      // No proof was taken, so there is nothing this could match against. Keep the tree.
      if (entry === undefined || entry.identity === undefined) return false;
      const information = await lstat(target);
      if (information.isDirectory() !== entry.directory) return false;
      if ((await identityOf(target, information)) !== entry.identity) return false;
      matched += 1;
      if (!entry.directory) return true;
      for (const name of await readdir(target)) {
        const child = relative === '' ? name : `${relative}/${name}`;
        if (!(await account(path.join(target, name), child))) return false;
      }
      return true;
    };

    if (!(await account(moved, ''))) return false;
    return matched === expected.size;
  }

  /**
   * Materialise one staged directory beneath its final name, recording every entry brought into
   * existence so a failed publish can prove which tree is its own.
   */
  private async publishTree(
    staged: string,
    destination: string,
    mode: number,
    created: PublishedName[],
    relative: string,
  ): Promise<void> {
    // Non-recursive: the parent must already exist, and an existing `destination` is somebody else's.
    await mkdir(destination, { mode });
    // Held open as soon as it exists, and opened **without following a link**. A descriptor refers
    // to the object rather than to the name, so the mode set at the end lands on whatever this
    // handle refers to even after the path is replaced. The no-follow matters as much as the
    // descriptor: `open` on a symlink to a directory succeeds and reports a directory, so a plain
    // open would hand back a handle to somebody else's directory and the final `chmod` would change
    // *their* permissions with no way to tell.
    //
    // **What this does not close, stated plainly:** `mkdir` returns no handle, so the `open` below
    // resolves the pathname a second time. `O_NOFOLLOW` rules out a *symlink* substituted in that
    // gap; it does nothing about a real directory swapped in, which opens perfectly well. Every
    // later check — including `assertUnswapped` — then compares against that replacement's inode,
    // so the substitution is invisible from here on. Closing it needs `mkdirat`/`openat`, which
    // Node does not expose; it is the same limitation the children below already carry. So this is
    // "the mode lands on the directory this opened", and only "the one this created" absent a swap
    // in a window this apply proved free moments earlier.
    const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const opened = await handle.stat();
      created.push({ relative, directory: true, identity: await identityOf(destination, opened) });
      for (const entry of await readdir(staged, { withFileTypes: true })) {
        const from = path.join(staged, entry.name);
        const to = path.join(destination, entry.name);
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        const information = await lstat(from);
        // Every child is reached by pathname, and no primitive available here can bind that
        // pathname to the descriptor above — `linkat` and its relatives are not exposed. So the
        // directory is re-identified before each child instead: a swap that has already happened is
        // refused rather than written through.
        await this.assertUnswapped(destination, opened);
        if (information.isDirectory()) {
          await this.publishTree(from, to, information.mode & MODE_BITS, created, child);
          continue;
        }
        // The identity comes back from the link itself, read off the staged entry. Observing `to`
        // here instead would bless whatever occupies that name by the time this line runs, which a
        // writer who replaces our file immediately after the link controls — and retract would then
        // delete their file as though it were ours.
        created.push({ relative: child, directory: false, identity: await this.publishFile(from, to, information) });
      }
      await this.assertUnswapped(destination, opened);
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  }

  /**
   * Refuse to keep writing into a name that no longer leads to the directory this publish made.
   *
   * This narrows the child-traversal race rather than closing it: without `linkat`, the check and
   * the write that follows it are two operations. What it does close is every interleaving where
   * the swap has already happened — which is the whole of the reachable damage from a swap that is
   * not perfectly timed — and the descriptor above closes the final `chmod` outright.
   */
  private async assertUnswapped(destination: string, opened: Stats): Promise<void> {
    const current = await lstat(destination);
    if (!current.isDirectory() || current.ino !== opened.ino || current.dev !== opened.dev) {
      throw new Error(`refusing to publish into ${destination}: it was replaced while the tree was being written`);
    }
  }

  /**
   * Place one staged regular file under a name nothing else holds, and say what was placed.
   *
   * `link` is the exclusive primitive: if a concurrent writer claimed this name after the parent
   * directory was created, it fails with `EEXIST` and their bytes stay theirs.
   *
   * **The proof is taken before the link, from the private staged entry.** Two separate races make
   * every later observation useless as evidence. Reading the live name after the link asks "what is
   * there now", so a writer who replaces the file in that gap gets *their* file blessed as this
   * publish's work — and the retract would then be entitled to delete it. Reading the staged name
   * after the link is no better: the two names are one inode, so a writer editing through the
   * published one changes what the staged one reports, and the blessing lands on their edit. Only
   * evidence gathered before the name exists at all is evidence about what we put there.
   *
   * It survives publication because it is built from the things `link` does not touch — the content,
   * and the stat fields other than `ctimeMs` and `nlink`.
   */
  private async publishFile(from: string, to: string, information: Stats): Promise<string | undefined> {
    // The copy dereferences its sources, so a link, a socket or a device here is not something this
    // apply produced — and hard-linking one into an account home is not a thing to do on a guess.
    if (!information.isFile()) {
      throw new Error(`refusing to publish ${to}: the staged entry is not a regular file`);
    }
    const identity = await identityOf(from, information);
    await link(from, to);
    return identity;
  }
}
