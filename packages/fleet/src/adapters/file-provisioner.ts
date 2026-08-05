import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
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
import { type FleetApplyLock, type FleetApplyLockOptions, fleetApplyLockFor } from './apply-lock.ts';
import { FileMutationJournal, isMutationBackupName } from './mutation-journal.ts';
import {
  ABSENT_DOCUMENT_REVISION,
  type FleetApplyCommittedState,
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

/** Reserved basename prefix for a replacement being built beside the entry it will become. */
const STAGE_PREFIX = '.fy-fleet-staged-';

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
        if (error instanceof FleetApplyFailureError) throw new FleetApplyFailureError(error.failure, lockResidue);
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
    await this.writeFileAtomically(document.path, document.content, document.mode);
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
    await this.validateOperationInputs(plan.operations);
  }

  /**
   * Prove every source an operation will read is present and usable. Nothing is written and nothing
   * is destroyed, so a configuration naming a missing asset or an unparseable settings layer is
   * refused with the host exactly as it was.
   */
  private async validateOperationInputs(operations: readonly FleetWriteOperation[]): Promise<void> {
    for (const operation of operations) {
      if (operation.kind === 'copy') {
        await stat(operation.source);
        continue;
      }
      if (operation.kind !== 'settings') continue;
      for (const layer of operation.layers) {
        if (layer.from === 'inline') continue;
        parseSettings(await readFile(layer.path, 'utf8'), operation.format);
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
    // These two operations traverse the final destination as a directory. Every other operation
    // replaces or lstat-checks its final entry, so only its ancestors may be followed.
    await this.assertWritablePath(operation.path, operation.kind === 'directory' || operation.kind === 'prune');
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
      const followsFinalComponent = operation.kind === 'directory' || operation.kind === 'prune';
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
      await this.writeFileAtomically(operation.path, content, operation.mode);
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
      // Built beside the destination, so the commit is a rename on the same device. A directory copy
      // is not atomic: staging it is what keeps a half-copied skills tree from ever being the live
      // one, and it means the destination survives untouched when the copy fails.
      const staged = path.join(path.dirname(operation.path), `${STAGE_PREFIX}${randomUUID()}`);
      try {
        await cp(operation.source, staged, { recursive: source.isDirectory(), dereference: true });
        // A template linked out of a read-only store copies as 0444; force the copied root writable
        // so a harness can rewrite a file it owns. Directories remain private to the account.
        await chmod(staged, operation.mode ?? (source.isDirectory() ? 0o700 : 0o644));
        if (!(await journal.capture(operation.path))) await rm(operation.path, { recursive: true, force: true });
        await this.publish(staged, operation.path);
      } finally {
        await discardQuietly(staged);
      }
      return [];
    }

    await journal.capture(operation.path);
    await this.writeFileAtomically(operation.path, operation.content, operation.mode);
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
      await this.writeFileAtomically(operation.markerPath, `${JSON.stringify(next)}\n`, 0o600);
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
          await this.writeFileAtomically(operation.path, serializeSettings(current, 'toml'), 0o600);
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
      // destroy the only copy of what this very batch may still need to put back.
      if (isMutationBackupName(entry) || entry.startsWith(STAGE_PREFIX)) continue;
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
    await this.writeFileAtomically(plan.manifestPath, content, 0o600);
  }

  private async writeFileAtomically(destination: string, content: string, mode: number): Promise<void> {
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx', mode });
      await chmod(temporary, mode);
      await this.publish(temporary, destination);
    } finally {
      await discardQuietly(temporary);
    }
  }

  /**
   * Move a staged entry into its final name, refusing rather than overwriting.
   *
   * Every destination is captured before this runs, so the name is free and `link` succeeds. If it
   * does not, something arrived in the window between the capture and the publish — and a rename,
   * which would silently replace it, is exactly the wrong answer. Directories cannot be linked, so
   * a staged tree is renamed after the same emptiness has been established by the capture.
   */
  private async publish(staged: string, destination: string): Promise<void> {
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
    // The trade is that the tree becomes visible entry by entry instead of all at once. That is
    // acceptable precisely because it stays truthful: a publish that fails part-way leaves the
    // operation unsealed, and an unsealed destination is reported rather than deleted on a guess.
    // Silently destroying somebody's file would not be truthful at any speed.
    await this.publishTree(staged, destination, information.mode & MODE_BITS);
    await rm(staged, { recursive: true, force: true });
  }

  private async publishTree(staged: string, destination: string, mode: number): Promise<void> {
    await mkdir(destination, { mode });
    for (const entry of await readdir(staged, { withFileTypes: true })) {
      const from = path.join(staged, entry.name);
      const to = path.join(destination, entry.name);
      const information = await lstat(from);
      if (information.isDirectory()) {
        await this.publishTree(from, to, information.mode & MODE_BITS);
        continue;
      }
      await this.publishFile(from, to, information);
    }
    await chmod(destination, mode);
  }

  /**
   * Place one staged regular file under a name nothing else holds.
   *
   * `link` is the exclusive primitive: if a concurrent writer claimed this name after the parent
   * directory was created, it fails with `EEXIST` and their bytes stay theirs.
   */
  private async publishFile(from: string, to: string, information: Stats): Promise<void> {
    // The copy dereferences its sources, so a link, a socket or a device here is not something this
    // apply produced — and hard-linking one into an account home is not a thing to do on a guess.
    if (!information.isFile()) {
      throw new Error(`refusing to publish ${to}: the staged entry is not a regular file`);
    }
    await link(from, to);
  }
}
