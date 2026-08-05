import { randomUUID } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FleetManifestSchema } from '../lib/manifest.ts';
import type {
  FleetApplyPlan,
  FleetApplyPreview,
  FleetApplyResult,
  FleetProvisioner,
  FleetWriteOperation,
  SettingsLayerSource,
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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
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

  constructor(
    allowedRoots: readonly string[],
    private readonly sharedHistory?: SharedHistoryMigration,
  ) {
    if (allowedRoots.length === 0) {
      throw new Error('at least one allowed fleet root is required');
    }
    this.allowedRoots = allowedRoots.map(root => path.resolve(root));
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

  async apply(plan: FleetApplyPlan): Promise<FleetApplyResult> {
    await this.preflightApply(plan);

    const prunedWrappers: string[] = [];
    let operationCount = 0;
    for (const operation of plan.operations) {
      // Recheck at the mutation boundary as well: an earlier operation must not be able to replace
      // an ancestor with a link after the all-or-nothing preflight has approved this destination.
      await this.assertOperationWritable(operation);
      const pruned = await this.applyOperation(operation);
      if (pruned === undefined) continue;
      operationCount += 1;
      prunedWrappers.push(...pruned);
    }

    // History migration has its own transactional boundary. Publish the ordinary fleet first so a
    // migration failure still leaves an honest record of the wrappers and homes that already landed.
    await this.writeManifest(plan);

    const sharedHistory = [];
    for (const request of plan.sharedHistoryRequests ?? []) {
      sharedHistory.push(await this.sharedHistoryMigration().materialize(request));
    }

    return {
      accountCount: plan.manifest.accounts.length,
      operationCount,
      manifestPath: plan.manifestPath,
      prunedWrappers,
      sharedHistory,
    };
  }

  /** Validate the published record before preview returns or apply performs its first write. */
  private async preflightPlan(plan: FleetApplyPlan): Promise<void> {
    FleetManifestSchema.parse(plan.manifest);
    await this.assertWritablePath(plan.manifestPath);
  }

  /** Validate every write before apply performs its first one. */
  private async preflightApply(plan: FleetApplyPlan): Promise<void> {
    await this.preflightPlan(plan);
    this.assertNoSharedHistoryRefusals(await this.previewSharedHistory(plan));
    for (const operation of plan.operations) await this.assertOperationWritable(operation);
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
  private async applyOperation(operation: FleetWriteOperation): Promise<readonly string[] | undefined> {
    if (operation.kind === 'directory') {
      await mkdir(operation.path, { recursive: true, mode: operation.mode });
      if (operation.mode !== undefined) {
        await chmod(operation.path, operation.mode);
      }
      return [];
    }

    if (operation.kind === 'prune') {
      return await this.prune(operation.path, operation.marker, new Set(operation.keep));
    }

    if (operation.kind === 'codex-sqlite-ownership') {
      return (await this.reconcileCodexSqliteOwnership(operation)) ? [] : undefined;
    }

    if (operation.kind === 'settings') {
      const content = await this.resolveSettings(operation.path, operation.format, operation.layers, {
        preserveExisting: operation.preserveExisting,
      });
      await mkdir(path.dirname(operation.path), { recursive: true });
      await rm(operation.path, { recursive: true, force: true });
      await this.writeFileAtomically(operation.path, content, operation.mode);
      return [];
    }

    await mkdir(path.dirname(operation.path), { recursive: true });
    await rm(operation.path, { recursive: true, force: true });

    if (operation.kind === 'symlink') {
      await symlink(operation.source, operation.path);
      return [];
    }
    if (operation.kind === 'copy') {
      // Profile assets may be files or directories. Dereference every source link: a copied account
      // home must not reintroduce a symlink beneath FY_HOME, where StateFileSystem deliberately
      // rejects symlink components to prevent an operation escaping its state-home boundary.
      const source = await stat(operation.source);
      await cp(operation.source, operation.path, { recursive: source.isDirectory(), dereference: true });
      // A template linked out of a read-only store copies as 0444; force the copied root writable so
      // a harness can rewrite a file it owns. Directories remain private to the account.
      await chmod(operation.path, operation.mode ?? (source.isDirectory() ? 0o700 : 0o644));
      return [];
    }
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
        if (marker.createdConfig && Object.keys(current).length === 0) {
          await rm(operation.path, { force: true });
        } else {
          await this.writeFileAtomically(operation.path, serializeSettings(current, 'toml'), 0o600);
        }
      }
    }
    await rm(operation.markerPath, { force: true });
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
  private async prune(directory: string, marker: string, keep: ReadonlySet<string>): Promise<readonly string[]> {
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch {
      return [];
    }

    const pruned: string[] = [];
    for (const entry of entries.toSorted()) {
      if (keep.has(entry)) continue;
      const target = path.join(directory, entry);
      const stats = await lstat(target);
      if (!stats.isFile()) continue;
      // An unreadable file inside a directory the fleet created at 0700 is an anomaly, and
      // swallowing it would leave a stale wrapper on PATH with nothing said about it.
      const content = await readFile(target, 'utf8');
      if (!content.includes(marker)) continue;
      await rm(target, { force: true });
      pruned.push(entry);
    }
    return pruned;
  }

  private async resolveSettings(
    destination: string,
    format: SettingsFormat,
    layers: readonly SettingsLayerSource[],
    options: { readonly preserveExisting: boolean },
  ): Promise<string> {
    const resolved: SettingsObject[] = [];
    if (options.preserveExisting) {
      const existing = await this.readExistingSettings(destination, format);
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
    try {
      const stats = await lstat(destination);
      if (!stats.isFile()) return undefined;
      return parseSettings(await readFile(destination, 'utf8'), format);
    } catch {
      return undefined;
    }
  }

  private async writeManifest(plan: FleetApplyPlan): Promise<void> {
    await this.assertWritablePath(plan.manifestPath);
    const content = `${JSON.stringify(plan.manifest, null, 2)}\n`;
    await mkdir(path.dirname(plan.manifestPath), { recursive: true });
    await this.writeFileAtomically(plan.manifestPath, content, 0o600);
  }

  private async writeFileAtomically(destination: string, content: string, mode: number): Promise<void> {
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx', mode });
      await chmod(temporary, mode);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
