import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FleetManifestSchema } from '../lib/manifest.ts';
import type {
  FleetApplyPlan,
  FleetApplyResult,
  FleetProvisioner,
  FleetWriteOperation,
  SettingsLayerSource,
} from '../lib/provisioning.ts';
import {
  mergeSettingsLayers,
  parseSettings,
  serializeSettings,
  type SettingsFormat,
  type SettingsObject,
} from '../lib/settings.ts';

/**
 * Writes a plan to a real filesystem.
 *
 * Every path is checked against the roots the composition root declared, so a configuration cannot
 * talk this adapter into writing outside the directories the fleet owns. Files are written to a
 * temporary name and renamed, so a reader never observes a half-written wrapper or manifest, and
 * the manifest is written last: it is the record that the rest of the plan already landed.
 */
export class FileFleetProvisioner implements FleetProvisioner {
  private readonly allowedRoots: readonly string[];

  constructor(allowedRoots: readonly string[]) {
    if (allowedRoots.length === 0) {
      throw new Error('at least one allowed fleet root is required');
    }
    this.allowedRoots = allowedRoots.map(root => path.resolve(root));
  }

  async apply(plan: FleetApplyPlan): Promise<FleetApplyResult> {
    FleetManifestSchema.parse(plan.manifest);
    this.assertWritablePath(plan.manifestPath);

    const prunedWrappers: string[] = [];
    for (const operation of plan.operations) {
      this.assertWritablePath(operation.path);
      prunedWrappers.push(...(await this.applyOperation(operation)));
    }

    await this.writeManifest(plan);
    return {
      accountCount: plan.manifest.accounts.length,
      operationCount: plan.operations.length,
      manifestPath: plan.manifestPath,
      prunedWrappers,
    };
  }

  private assertWritablePath(target: string): void {
    const resolved = path.resolve(target);
    const allowed = this.allowedRoots.some(root => {
      const relative = path.relative(root, resolved);
      return (
        relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
      );
    });
    if (!allowed) {
      throw new Error(`refusing to write outside configured fleet roots: ${target}`);
    }
  }

  /** Returns the names pruned by this operation; every other operation returns nothing. */
  private async applyOperation(operation: FleetWriteOperation): Promise<readonly string[]> {
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
