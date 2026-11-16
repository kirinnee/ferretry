import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { FleetManifestSchema } from '../lib/manifest.ts';
import {
  keptAsideName,
  keptAsideText,
  MAX_KEPT_DAMAGE_BYTES,
  manifestRebuiltSentence,
  readManifestText,
} from '../lib/manifest-reading.ts';
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
  type SkippedDestination,
} from '../lib/provisioning.ts';
import {
  mergeSettingsLayers,
  parseSettings,
  type SettingsFormat,
  type SettingsObject,
  serializeSettings,
} from '../lib/settings.ts';
import { AlreadyExistsError, type FleetDisk } from './fleet-disk.ts';
import { FileMutationJournal, isMutationReservedName, STAGE_PREFIX } from './mutation-journal.ts';
import type { ApplyLock, MutationJournal, SharedHistoryPooling } from './ports.ts';

/*
 * The provisioner is written over `FleetDisk` (`./fleet-disk.ts`): every file call is an asynchronous call on the
 * kernel's `fleet` root. The order of operations, the checks and every sentence are today's, with these declared
 * differences, each a consequence of what a root offers:
 *
 *  - A copy is published by `rename` onto a free name (a root has no hard link). A tree therefore appears whole, not
 *    entry by entry, and there is no half-published tree to retract: a failure after the move is the journal's
 *    rollback of one entry.
 *  - A link inside a copied folder is SKIPPED by the root, not dereferenced, and a file with a second hard link is
 *    skipped too. A sign-in file anywhere in a copied folder refuses the copy (S144).
 *  - A link leads to the target's REAL path, not to the spelling the plan used.
 *  - Modes are the root's: an internal root keeps owner bits only (`mode & 0o700`) when a mode is SET on an existing
 *    entry (a copied folder or file); a file created by `create` keeps exactly the mode it was given.
 *  - A source outside the fleet's assets and the harness homes is refused in a sentence: it has no root a plugin may
 *    declare (S43). Both are read through roots scoped to them, so a link that leaves the folder at ANY hop is refused,
 *    and a sign-in is refused by its real path too (S144); the stored credentials are only a dangling link's target.
 *  - The shared-history migration is `conversation`'s (GAP(conversation)).
 */

/** One account home a shared-history preview could not read. GAP(conversation): the preview shape is the pool's. */
interface HistoryRefusal {
  readonly account: string;
  readonly home: string;
  readonly reason: string;
}

/** A folder an apply makes on the way to a file, as `mkdir` makes one by default (the umask applies). */
const DEFAULT_FOLDER_MODE = 0o777;

/** The largest file the provisioner reads whole to judge it (a wrapper, a settings file, a record, a document). */
const MAX_READ_BYTES = 4 * 1024 * 1024;

const MaterialisedRecordSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(z.string()).readonly(),
});

/** Parsed JSON, or `undefined` for text that is not JSON. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A name that is exactly one entry of its directory: never a path that could reach outside it. */
const isSingleComponent = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes(path.sep);

/**
 * Drop a staged replacement without ever becoming the reported failure. These run in a `finally`, on both the
 * succeeding and the failing path: a throw here would replace the error that caused the failure. Leftovers carry a
 * reserved prefix, are skipped by the sweep, and are inert.
 */
async function discardQuietly(disk: FleetDisk, staged: string): Promise<void> {
  try {
    if ((await disk.lstat(staged)) !== undefined) await disk.remove(staged);
  } catch {
    // Deliberately swallowed: see above.
  }
}

/**
 * Whether this operation enters its destination as a directory rather than replacing it. One predicate for the two
 * places that ask, because they must agree: the preflight and the mutation boundary check the same question.
 */
const traversesDestination = (operation: FleetWriteOperation): boolean =>
  operation.kind === 'directory' || operation.kind === 'prune' || operation.kind === 'prune-directory';

/**
 * Put the lock residue inside the committed state as well as on the error that carries it: a committed apply whose
 * history migration then failed reports what the host now IS, and a claim nobody could clear blocks the next apply.
 */
function withLockResidue(failure: FleetApplyFailure, lockResidue: string): FleetApplyFailure {
  if (failure.kind !== 'history-failed-after-commit') return failure;
  return { ...failure, committed: { ...failure.committed, lockResidue } };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/**
 * Writes a plan to the fleet folder.
 *
 * Every path is checked against the fleet folder, so a configuration cannot talk this adapter into writing anywhere
 * else. A file is created exclusively (the root links a private temporary into place), so a reader never observes a
 * half-written wrapper or manifest. The manifest is published after ordinary operations and before history migration:
 * it records the provisioned fleet even when a separate history migration subsequently fails.
 */
export class FileFleetProvisioner implements FleetProvisioner {
  /** Tail of the serialized apply chain. Reads and previews are unaffected. */
  private queue: Promise<void> = Promise.resolve();
  constructor(
    /** The fleet root and the folders a component may come from (`./fleet-disk.ts`). */
    private readonly disk: FleetDisk,
    /** The claim for the fleet whose manifest is at the path (`./apply-claim.ts`). */
    private readonly claimFor: (manifestPath: string) => ApplyLock,
    private readonly sharedHistory?: SharedHistoryPooling,
    /**
     * Run around the mutation itself, once the claim is held and before anything is moved aside.
     *
     * A published name is ABSENT between being moved aside and its replacement being created, so a reader in that gap
     * sees no manifest, no ids and no wrapper — not the old fleet and not the new one (S67). A daemon passes the section
     * that keeps its own readers out of that gap. It wraps only the mutation, never the wait for the claim, and ends at
     * the commit or at the rollback of a failure. Absent, the mutation simply runs.
     */
    private readonly publishing?: <T>(mutate: () => Promise<T>) => Promise<T>,
    /** Told, in one plain line, that an unreadable manifest is being rebuilt (the file is named, its contents never). */
    private readonly say?: (sentence: string) => void,
    /** The time an aside file records as `keptAt`. */
    private readonly now: () => Date = () => new Date(),
  ) {}

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
   * `documents` are files of the fleet folder (the asset tree) and are written first, inside the same boundary, because
   * a document and the fleet it describes are only atomic together. A document outside the fleet folder (a
   * configuration file) is refused here: it is written by the all-or-none config writer BEFORE this runs.
   *
   * The commit point is the manifest. Everything before it is undone on failure; the history migration that follows has
   * its own boundary and never rolls the fleet back, so a failure there is reported as the different thing it is.
   */
  async apply(plan: FleetApplyPlan, documents: readonly FleetDocumentWrite[] = []): Promise<FleetApplyResult> {
    // One apply at a time per state home. Two overlapping applies capture each other's writes as "the state before",
    // so their rollbacks undo one another. The queue orders callers inside this one object; the claim orders this
    // object against anything else that applies.
    // Containment is decided before the claim: the claim lives beside the manifest, so taking it first would create a
    // folder for a plan that is about to be refused.
    await this.assertWritablePath(plan.manifestPath);
    const lock = this.claimFor(plan.manifestPath);
    await this.assertWritablePath(lock.path);
    const guarded = async (): Promise<FleetApplyResult> => {
      const token = await lock.acquire();
      try {
        const result = await this.applyExclusively(plan, documents);
        const lockResidue = await lock.release(token);
        return lockResidue === undefined ? result : { ...result, lockResidue };
      } catch (error) {
        // The release runs either way, and its residue never changes what the apply was.
        const lockResidue = await lock.release(token);
        if (lockResidue === undefined) throw error;
        if (error instanceof FleetApplyFailureError) {
          throw new FleetApplyFailureError(withLockResidue(error.failure, lockResidue), lockResidue);
        }
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

    const journal: MutationJournal = new FileMutationJournal(this.disk, target => this.assertWritablePath(target));
    const prunedWrappers: string[] = [];
    const skipped: SkippedDestination[] = [];
    let operationCount = 0;
    let stage = 'the configuration and asset documents';

    // Everything a reader could catch moved aside — the documents, the operations, the manifest and a rollback of any
    // of them — and nothing after the commit, which leaves every published name in place.
    const mutate = async (): Promise<void> => {
      await this.keepUnreadableManifest(plan.manifestPath);
      try {
        for (const document of documents) {
          const mark = journal.beginOperation();
          await this.writeDocument(document, journal);
          await journal.sealOperation(mark);
        }

        for (const operation of plan.operations) {
          stage = `${operation.kind} ${operation.path}`;
          // Recheck at the mutation boundary as well: an earlier operation must not be able to replace an ancestor
          // with a link after the all-or-nothing preflight approved this destination.
          await this.assertOperationWritable(operation);
          const mark = journal.beginOperation();
          const pruned = await this.applyOperation(operation, journal, skipped);
          await journal.sealOperation(mark);
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
    };
    await (this.publishing === undefined ? mutate() : this.publishing(mutate));

    // Committed. Cleanup from here is best-effort and never reclassifies a successful apply.
    const backupResidue = await journal.discard();
    // A function, because a shared-history migration this host cannot make safely is skipped below and joins it.
    const residue = () => ({
      ...(backupResidue.length === 0 ? {} : { backupResidue }),
      ...(skipped.length === 0 ? {} : { skipped: [...skipped] }),
    });

    const committed = (sharedHistory: FleetApplyPreview['sharedHistory']): FleetApplyCommittedState => ({
      accountCount: plan.manifest.accounts.length,
      operationCount,
      manifestPath: plan.manifestPath,
      manifest: plan.manifest,
      prunedWrappers,
      sharedHistory,
      ...residue(),
    });

    const sharedHistory = [];
    for (const request of plan.sharedHistoryRequests ?? []) {
      try {
        sharedHistory.push(await this.sharedHistoryPooling().materialize(request));
      } catch (error) {
        // Not made: the rest of the apply stands. v4 had a pooling, so a person never read about one that is missing;
        // this is not told as a skipped file either (GAP(shared-history): the pooling is not built in 5.0 yet).
        if (this.sharedHistoryPooling().isUnavailable(error)) continue;
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
      ...residue(),
    };
  }

  /** Undo the batch and classify what the host is now, which is the only thing a caller can act on. */
  private async rollback(journal: MutationJournal, stage: string, error: unknown): Promise<Error> {
    const { unrestored, displaced } = await journal.rollback();
    const reason = error instanceof Error ? error.message : String(error);
    // "Rolled back" is a claim about the host, not about the fleet: anything of somebody else's that had to be moved out
    // of the way leaves a renamed path and a reserved file behind, so it belongs with the incomplete outcomes.
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

  private async writeDocument(document: FleetDocumentWrite, journal: MutationJournal): Promise<void> {
    await this.assertWritablePath(document.path);
    await journal.captureDirectory(path.dirname(document.path));
    await journal.capture(document.path);
    // Checked here and nowhere earlier. The capture has already moved whatever was at the path out of everyone's
    // reach, so what it moved aside is exactly what this write is replacing and the answer cannot go stale between the
    // question and the write. Unconditional, deliberately: a write that expected to find a file and finds nothing is a
    // write whose author never saw the deletion, and recreating the file would silently undo it.
    if (document.expect !== undefined) await this.assertExpected(document, journal);
    // The capture has already moved the old document aside, so leaving the path empty IS the removal.
    if (document.remove === true) return;
    await this.writeFileAtomically(document.path, document.content, document.mode);
  }

  private async assertExpected(document: FleetDocumentWrite, journal: MutationJournal): Promise<void> {
    const found =
      (await journal.withBackup(document.path, async backup => {
        const entry = await this.disk.lstat(backup);
        if (entry === undefined) throw new Error(`the original of ${document.path} is gone from ${backup}`);
        // A document that is a link is not followed (the root never does): it cannot be proved to be what the change was
        // composed against, so the write is refused rather than guessed at.
        if (entry.kind !== 'file') {
          throw new Error(
            `refusing to write ${document.path}: what is there is not a regular file, so it cannot be compared with what this change was composed against`,
          );
        }
        return sha256(await this.disk.readBytes(backup, MAX_READ_BYTES));
      })) ?? ABSENT_DOCUMENT_REVISION;
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
    // Reading every input here — not at the operation that consumes it — is what turns a whole class of mid-apply
    // failures into a refusal that never touched the host.
    await this.previewOperations(plan.operations, sharedHistory);
    await this.validateOperationInputs(plan.operations, documents);
  }

  /**
   * Prove every source an operation will read is present and usable. Nothing is written and nothing is destroyed, so a
   * configuration naming a missing asset, a source this plugin may not read or an unparseable settings layer is refused
   * with the host exactly as it was (S43: a component source in the daemon's home is refused here, and again at the copy).
   *
   * A source THIS APPLY WRITES is proved from the document rather than from the disk: documents are written first and
   * inside the same boundary, so by the time the operation runs the file is there.
   */
  private async validateOperationInputs(
    operations: readonly FleetWriteOperation[],
    documents: readonly FleetDocumentWrite[],
  ): Promise<void> {
    const pending = new Map(documents.map(document => [path.resolve(document.path), document.content]));
    // A folder a document of this apply lands in is there by the time the operation runs too.
    const pendingFolders = new Set<string>();
    for (const written of pending.keys()) {
      for (let folder = path.dirname(written); !pendingFolders.has(folder); folder = path.dirname(folder)) {
        pendingFolders.add(folder);
      }
    }
    for (const operation of operations) {
      // A LINK IS CHECKED EXACTLY LIKE A COPY, and it has to be checked HERE rather than left to the write: a link to
      // nothing is created perfectly happily, so the apply would report success and the harness would find nothing.
      if (operation.kind === 'copy' || operation.kind === 'symlink') {
        // A credential link is the one declared exception: an empty slot's file does not exist until somebody signs in,
        // and the harness writes it through the link. It is still held to the folders a link may lead into.
        const dangling = operation.kind === 'symlink' && operation.dangling === true;
        const source = path.resolve(operation.source);
        const writtenHere = pending.has(source) || pendingFolders.has(source);
        if (operation.kind === 'symlink') await this.disk.checkLinkTarget(source, dangling || writtenHere);
        else if (writtenHere) this.disk.assertServed(source);
        else await this.disk.assertSource(source);
        continue;
      }
      if (operation.kind !== 'settings') continue;
      for (const layer of operation.layers) {
        if (layer.from === 'inline') continue;
        const written = pending.get(path.resolve(layer.path));
        parseSettings(written ?? (await this.disk.readSourceText(layer.path)), operation.format);
      }
    }
  }

  /** A partly observed history request must refuse before any ordinary or history mutation lands. */
  private assertNoSharedHistoryRefusals(previews: FleetApplyPreview['sharedHistory']): void {
    for (const preview of previews) {
      const refusals = preview.refusals;
      if (refusals.length === 0) continue;
      throw new Error(
        `refusing to pool ${preview.kind} history while ${refusals.length} account home(s) cannot be read: ${refusals
          .map((refusal: HistoryRefusal) => `${refusal.account} (${refusal.home}): ${refusal.reason}`)
          .join('; ')}`,
      );
    }
  }

  private async assertOperationWritable(operation: FleetWriteOperation): Promise<void> {
    await this.assertWritablePath(operation.path, traversesDestination(operation));
  }

  /**
   * Every operation the plan will perform, after checking each destination is inside the fleet folder. A destination
   * represented by a refused account home is kept visible, never inspected: shared-history preview turns an
   * out-of-root account home into structured, renderable evidence.
   */
  private async previewOperations(
    operations: readonly FleetWriteOperation[],
    sharedHistory: FleetApplyPreview['sharedHistory'],
  ): Promise<readonly FleetWriteOperation[]> {
    const refusedHomes = sharedHistory.flatMap(preview =>
      preview.refusals.map((refusal: HistoryRefusal) => refusal.home),
    );
    const previewed: FleetWriteOperation[] = [];
    for (const operation of operations) {
      const pathWritable = this.isWritablePath(operation.path);
      if (!pathWritable && !this.isRepresentedByRefusedHome(operation.path, refusedHomes)) {
        throw new Error(`refusing to write outside configured fleet roots: ${operation.path}`);
      }
      previewed.push(operation);
    }
    return previewed;
  }

  private isRepresentedByRefusedHome(target: string, refusedHomes: readonly string[]): boolean {
    const resolved = path.resolve(target);
    return refusedHomes.some(home => {
      const relative = path.relative(path.resolve(home), resolved);
      return (
        relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      );
    });
  }

  private async previewSharedHistory(plan: FleetApplyPlan): Promise<FleetApplyPreview['sharedHistory']> {
    if ((plan.sharedHistoryRequests?.length ?? 0) === 0) return [];
    const pooling = this.sharedHistoryPooling();
    const previews = [];
    for (const request of plan.sharedHistoryRequests ?? []) {
      try {
        previews.push(await pooling.preview(request));
      } catch (error) {
        // A migration this host cannot make safely is left out of the plan, not a reason to refuse the apply.
        if (!pooling.isUnavailable(error)) throw error;
      }
    }
    return previews;
  }

  private sharedHistoryPooling(): SharedHistoryPooling {
    if (this.sharedHistory === undefined) {
      throw new Error('shared-history operations were planned without a shared-history filesystem adapter');
    }
    return this.sharedHistory;
  }

  /**
   * A path is writable when it is the fleet folder or below it, by name; the root then refuses a link on the way at
   * every call. The fleet folder is inside itself: the one directory every first run has to create.
   */
  private async assertWritablePath(target: string, _followFinalComponent = false): Promise<void> {
    if (!this.isWritablePath(target)) {
      throw new Error(`refusing to write outside configured fleet roots: ${target}`);
    }
  }

  private isWritablePath(target: string): boolean {
    return this.disk.contains(path.resolve(target));
  }

  /** Returns pruned names. */
  private async applyOperation(
    operation: FleetWriteOperation,
    journal: MutationJournal,
    skipped: SkippedDestination[],
  ): Promise<readonly string[]> {
    if (operation.kind === 'directory') {
      await journal.captureDirectory(operation.path, operation.mode);
      await this.disk.makeFolder(operation.path, operation.mode ?? DEFAULT_FOLDER_MODE);
      // The fleet folder itself is made by the kernel at the mode the root keeps; its own mode is not the plan's to set.
      if (operation.mode !== undefined && path.resolve(operation.path) !== this.disk.directory) {
        await this.disk.setMode(operation.path, operation.mode);
      }
      return [];
    }

    if (operation.kind === 'prune') {
      return await this.prune(operation.path, operation.marker, new Set(operation.keep), journal);
    }

    if (operation.kind === 'prune-directory') {
      if (operation.only === undefined) await this.pruneDirectory(operation.path, new Set(operation.keep), journal);
      else await this.retireEntries(operation.path, operation.only, new Set(operation.keep), operation.record, journal);
      // Deliberately no names: the caller collects what it reports as pruned WRAPPERS, and a removed skill item is not
      // one. What was removed is visible where a person decides — the dry run states the directory and the keep set.
      return [];
    }

    if (operation.kind === 'settings') {
      await journal.captureDirectory(path.dirname(operation.path));
      // Clear the path only when this batch already owned it. After a fresh capture the path is empty, and anything
      // that has appeared since belongs to somebody else — the exclusive create then fails rather than silently
      // replacing their file.
      if (!(await journal.capture(operation.path))) await this.removeEntry(operation.path);
      // Resolved from what the capture moved aside, not from the live path before it: the backup cannot change under
      // this read, so the keys folded in are exactly the keys that were there when this operation took ownership.
      const existing = operation.preserveExisting
        ? await journal.withBackup(
            operation.path,
            async backup => await this.readExistingSettings(backup, operation.format),
          )
        : undefined;
      const content = await this.resolveSettings(existing, operation.format, operation.layers, {
        replaceKeys: operation.replaceKeys ?? [],
      });
      await this.writeFileAtomically(operation.path, content, operation.mode);
      return [];
    }

    await journal.captureDirectory(path.dirname(operation.path));
    await this.disk.makeFolder(path.dirname(operation.path), DEFAULT_FOLDER_MODE);
    await this.writeEntry(operation, journal, skipped);
    return [];
  }

  /** Removes the entry at `target` — a file, a link or a tree — never following a link. */
  private async removeEntry(target: string): Promise<void> {
    if ((await this.disk.lstat(target)) !== undefined) await this.disk.remove(target);
  }

  /** A link, a copy or a file, written into its folder. */
  private async writeEntry(
    operation: Extract<FleetWriteOperation, { readonly kind: 'symlink' | 'copy' | 'file' }>,
    journal: MutationJournal,
    skipped: SkippedDestination[],
  ): Promise<void> {
    if (operation.kind === 'symlink') {
      // Clear the path only when this batch already owned it. After a fresh capture the path is empty, and anything
      // that has appeared since belongs to somebody else: the link then fails as a refusal instead of deleting their work.
      if (!(await journal.capture(operation.path))) await this.removeEntry(operation.path);
      // Asked again at the write: what the link leads to is read later by the harness, so this is the last moment the
      // daemon can refuse it. Nothing is read here: a credential link is the planner's own and leads into a home.
      await this.disk.linkTo(operation.path, operation.source, operation.dangling === true);
      return;
    }

    if (operation.kind === 'copy') {
      // Profile assets may be files or directories. Built beside the destination, so publishing never crosses a device,
      // and staging is what keeps a half-copied tree from ever being live: the copy either completes into the staged
      // name or fails there, and the destination survives untouched either way.
      const staged = path.join(path.dirname(operation.path), `${STAGE_PREFIX}${randomUUID()}`);
      try {
        // The root reads each file through a checked descriptor (a source swapped for a link copies nothing), refuses a
        // folder holding a sign-in file (S144), and serves only the folders a plugin may declare (S43).
        const { kind, left } = await this.disk.copyInto(operation.source, staged, 0o600);
        // A template linked out of a read-only store copies as 0444; force the copied root writable so a harness can
        // rewrite a file it owns. Directories remain private to the account.
        await this.disk.setMode(staged, operation.mode ?? (kind === 'directory' ? 0o700 : 0o644));
        if (!(await journal.capture(operation.path))) await this.removeEntry(operation.path);
        await this.publish(staged, operation.path);
        // Named in the outcome of a committed apply: what the copy could not carry is missing from the destination.
        skipped.push(...left.map(entry => ({ path: path.join(operation.path, entry.path), reason: entry.reason })));
      } finally {
        await discardQuietly(this.disk, staged);
      }
      return;
    }

    await journal.capture(operation.path);
    await this.writeFileAtomically(operation.path, operation.content, operation.mode);
  }

  /** The text of the regular file at `target`, read without following a link. */
  private async readRegularText(target: string, label: string): Promise<string | undefined> {
    const information = await this.disk.lstat(target);
    if (information === undefined) return undefined;
    if (information.kind !== 'file') throw new Error(`${label} must be a regular file: ${target}`);
    return await this.disk.readText(target, MAX_READ_BYTES);
  }

  /**
   * Remove managed files in `directory` that nothing claims any more. Bounded twice: only direct children, and only
   * files whose text carries `marker`. A symlink, a subdirectory, or a file the user wrote by hand is never touched, so
   * an unrelated executable on the same `PATH` directory survives.
   */
  private async prune(
    directory: string,
    marker: string,
    keep: ReadonlySet<string>,
    journal: MutationJournal,
  ): Promise<readonly string[]> {
    if ((await this.disk.lstat(directory))?.kind !== 'directory') return [];
    const entries = await this.disk.entries(directory);
    const pruned: string[] = [];
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (keep.has(entry.name)) continue;
      // A backup of a managed wrapper still carries the managed marker. Sweeping it away would destroy the only copy of
      // what this very batch may still need to put back.
      if (isMutationReservedName(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.kind !== 'file') continue;
      // An unreadable file inside a directory the fleet created at 0700 is an anomaly, and swallowing it would leave a
      // stale wrapper on PATH with nothing said about it.
      const content = await this.disk.readText(target, MAX_READ_BYTES);
      if (!content.includes(marker)) continue;
      await journal.capture(target);
      // The decision was made from the file as it was read; the capture moved aside the file as it is now. If something
      // replaced it in between, what was moved aside is not what this sweep agreed to remove — so the apply fails here
      // and the rollback decides.
      if (!(await this.stillCarries(journal, target, marker))) {
        throw new Error(`refusing to prune ${target}: it changed between being read and being removed`);
      }
      pruned.push(entry.name);
    }
    return pruned;
  }

  /**
   * Empty a directory the fleet materialized entry by entry of everything this plan did not put there. Bounded to direct
   * children and to the keep list, and — unlike {@link prune} — it removes directories as well as files, because the
   * entries here ARE directories: one skill item is a tree. Removal goes through the journal, so a later failure puts
   * each swept entry back exactly where it was.
   */
  private async pruneDirectory(directory: string, keep: ReadonlySet<string>, journal: MutationJournal): Promise<void> {
    if ((await this.disk.lstat(directory))?.kind !== 'directory') return;
    for (const entry of (await this.disk.entries(directory)).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (keep.has(entry.name)) continue;
      // A backup or staging name belongs to this very batch; sweeping one away would destroy the only copy of what a
      // rollback needs to put back.
      if (isMutationReservedName(entry.name)) continue;
      await journal.capture(path.join(directory, entry.name));
    }
  }

  /**
   * Remove the named direct children of a directory the plan shares with the harness and the person, each only on
   * evidence it is the plan's own: a symbolic link, or an entry the previous apply's record names. A regular file or a
   * directory with neither — a person's own `CLAUDE.md` — stays.
   */
  private async retireEntries(
    directory: string,
    only: readonly string[],
    keep: ReadonlySet<string>,
    record: string | undefined,
    journal: MutationJournal,
  ): Promise<void> {
    const recorded = record === undefined ? new Set<string>() : await this.recordedEntries(record);
    if ((await this.disk.lstat(directory))?.kind !== 'directory') return;
    for (const entry of only) {
      if (keep.has(entry) || isMutationReservedName(entry) || !isSingleComponent(entry)) continue;
      const target = path.join(directory, entry);
      const information = await this.disk.lstat(target);
      if (information === undefined) continue;
      if (information.kind !== 'symlink' && !recorded.has(entry)) continue;
      await journal.capture(target);
    }
  }

  /**
   * What the previous apply recorded putting in a directory. No record, or one that cannot be read as one, is an empty
   * record: the cost is a leftover the next apply cannot prove is its own, which is the safe direction to be wrong in.
   */
  private async recordedEntries(record: string): Promise<ReadonlySet<string>> {
    let document: string | undefined;
    try {
      document = await this.readRegularText(record, 'materialised record');
    } catch {
      return new Set();
    }
    if (document === undefined) return new Set();
    const parsed = MaterialisedRecordSchema.safeParse(safeJson(document));
    return new Set(parsed.success ? parsed.data.entries : []);
  }

  private async stillCarries(journal: MutationJournal, target: string, marker: string): Promise<boolean> {
    const carries = await journal.withBackup(target, async backup => {
      if ((await this.disk.lstat(backup))?.kind !== 'file') return false;
      return (await this.disk.readText(backup, MAX_READ_BYTES)).includes(marker);
    });
    return carries ?? false;
  }

  /** `existing` is the destination's own settings as the capture moved them aside, to fold in as the base layer. */
  private async resolveSettings(
    existing: SettingsObject | undefined,
    format: SettingsFormat,
    layers: readonly SettingsLayerSource[],
    options: { readonly replaceKeys: readonly string[] },
  ): Promise<string> {
    const resolved: SettingsObject[] = [];
    // A replaced key is the plan's, all of it, so nothing of the old value may survive the merge.
    if (existing !== undefined) {
      resolved.push(Object.fromEntries(Object.entries(existing).filter(([key]) => !options.replaceKeys.includes(key))));
    }
    for (const layer of layers) {
      resolved.push(
        layer.from === 'inline'
          ? layer.settings
          : parseSettings(await this.disk.readSourceText(path.resolve(layer.path)), format),
      );
    }
    return serializeSettings(mergeSettingsLayers(resolved), format);
  }

  /**
   * The file the harness has been writing to, folded back in as the base layer so a re-apply keeps runtime keys. A
   * symlink holds only template content and an unparseable file holds nothing that can be merged, so both yield nothing
   * rather than failing the apply.
   */
  private async readExistingSettings(backup: string, format: SettingsFormat): Promise<SettingsObject | undefined> {
    const stats = await this.disk.lstat(backup);
    // Absent is the ordinary first-apply case and carries nothing to preserve.
    if (stats === undefined) return undefined;
    // A symlink is the one justified exception: it holds template content the assets directory is the authority for,
    // not runtime keys, so there is nothing of the person's in it to lose. Everything else is fail-closed: a settings
    // file that cannot be read or parsed — and a directory or a device node where one should be — is state this apply
    // is about to replace with a merge computed without it.
    if (stats.kind === 'symlink') return undefined;
    if (stats.kind !== 'file') {
      throw new Error(`refusing to merge settings over ${backup}: it is not a regular file`);
    }
    let document: string;
    try {
      document = await this.disk.readText(backup, MAX_READ_BYTES);
    } catch (error) {
      throw new Error(`refusing to merge settings over ${backup}: it could not be read (${reasonOf(error)})`);
    }
    try {
      return parseSettings(document, format);
    } catch (error) {
      throw new Error(`refusing to merge settings over ${backup}: it could not be parsed (${reasonOf(error)})`);
    }
  }

  /**
   * A manifest on disk that is not one is derived data this apply writes again, so it never refuses the apply. Before it
   * is replaced the damaged bytes are kept ONCE, in ONE fixed aside file beside it (a self-describing envelope, owner-only),
   * so a person can still look at what the last version wrote. A copy rather than a move: the original stays in place until
   * the apply's own journal replaces it, so no reader sees the gap and a rolled-back apply leaves it exactly as it was.
   * Nothing is ever deleted or replaced: the aside is created once, when the name is free. Anything already at the name
   * (whoever made it, our own earlier aside included) is left exactly as it is. Best-effort: a copy that cannot be kept is
   * said once, naming the aside, and the manifest is still rebuilt.
   */
  private async keepUnreadableManifest(manifestPath: string): Promise<void> {
    const entry = await this.disk.lstat(manifestPath);
    if (entry?.kind !== 'file') return;
    let bytes: Uint8Array | undefined;
    try {
      // A read stops at its limit without saying so: one byte more than the bound tells a file that is too big (not kept,
      // and never a truncated copy of it) from one that just fits.
      bytes = await this.disk.readBytes(manifestPath, MAX_KEPT_DAMAGE_BYTES + 1);
      if (bytes.length > MAX_KEPT_DAMAGE_BYTES) bytes = undefined;
    } catch {
      bytes = undefined;
    }
    if (bytes !== undefined && readManifestText(new TextDecoder().decode(bytes)).kind !== 'unreadable') return;
    const aside = keptAsideName(manifestPath);
    const kept = bytes !== undefined && (await this.keepAside(aside, bytes));
    this.say?.(manifestRebuiltSentence(manifestPath, aside, kept));
  }

  /**
   * Whether `damaged` is now kept at `target`. Written through the one
   * root writer (a private temporary, then an exclusive link onto the name): ONLY when the name is free. A name that is
   * taken, by anything, is left untouched and nothing is written, so no publish or rename ever reaches an existing
   * entry. No call here removes anything.
   */
  private async keepAside(target: string, damaged: Uint8Array): Promise<boolean> {
    try {
      if ((await this.disk.lstat(target)) !== undefined) return false;
      await this.disk.create(target, Buffer.from(keptAsideText(damaged, sha256(damaged), this.now())), 0o600);
      return true;
    } catch {
      return false;
    }
  }

  private async writeManifest(plan: FleetApplyPlan, journal: MutationJournal): Promise<void> {
    await this.assertWritablePath(plan.manifestPath);
    const content = `${JSON.stringify(plan.manifest, null, 2)}\n`;
    await journal.captureDirectory(path.dirname(plan.manifestPath));
    await journal.capture(plan.manifestPath);
    await this.writeFileAtomically(plan.manifestPath, content, 0o600);
  }

  /**
   * Creates `destination` with `content`: the folder made first (each missing folder with the default folder mode), the
   * file created exclusively by the root (a private temporary linked into place), so a name that appeared since the
   * capture is refused rather than replaced.
   */
  private async writeFileAtomically(destination: string, content: string, mode: number): Promise<void> {
    await this.disk.makeFolder(path.dirname(destination), DEFAULT_FOLDER_MODE);
    try {
      await this.disk.create(destination, Buffer.from(content), mode);
    } catch (error) {
      if (error instanceof AlreadyExistsError) {
        throw new Error(`refusing to publish ${destination}: something arrived at the name after it was cleared`);
      }
      throw error;
    }
  }

  /**
   * Move a staged entry into its final name, refusing rather than overwriting.
   *
   * Every destination is captured before this runs, so the name is free and the move succeeds. If it does not,
   * something arrived in the window between the capture and the publish — and the root refuses a taken name rather than
   * replacing it. A directory moves whole.
   */
  private async publish(staged: string, destination: string): Promise<void> {
    const information = await this.disk.lstat(staged);
    // The copy makes regular files and folders only: anything else at the staged name was put there since, by whoever
    // can write the account's folder, and is not published under the account's name.
    if (information?.kind !== 'file' && information?.kind !== 'directory') {
      throw new Error(`refusing to publish ${destination}: the staged entry is not a regular file or a folder`);
    }
    try {
      await this.disk.rename(staged, destination);
    } catch (error) {
      if ((await this.disk.lstat(destination)) !== undefined) {
        throw new Error(`refusing to publish ${destination}: something arrived at the name after it was cleared`, {
          cause: error,
        });
      }
      throw error;
    }
  }
}
