import { basename, dirname, join } from 'node:path';
import type { FileIdentity, HostFs, OpenedDirectory } from './adapters/node-fs.ts';
import type { FolderRemoval, FolderSteps } from './adapters/pinned/descriptor-folder.ts';
import { same } from './fence-guard.ts';
import type { RootRefusal } from './roots.ts';
import type { RootIdentity } from '../contract/ports/roots.ts';

interface RemovalScope {
  readonly fs: HostFs;
  readonly base: { readonly real: string };
  readonly ownerRoot: boolean;
}

/** Existing removal walk, with the root's fence checks supplied by its owner. */
export function rootRemoval<S extends RemovalScope>(checks: {
  readonly openCheckedFolder: (scope: S, real: string) => Promise<OpenedDirectory>;
  readonly folderProblem: (scope: S, real: string, opened: FileIdentity) => Promise<RootRefusal | undefined>;
  readonly heldMember: (scope: S, identity: FileIdentity) => Promise<boolean>;
  readonly refuseHeldName: (scope: S, path: string) => Promise<void>;
  readonly refuse: (reason: RootRefusal) => never;
}): (
  scope: S,
  full: string,
  onlyIfEmpty: boolean,
  expectedIdentity?: RootIdentity,
  beforeDelete?: () => Promise<void>,
) => Promise<void> {
  const { openCheckedFolder, folderProblem, heldMember, refuseHeldName, refuse } = checks;
  const errnoOf = (error: unknown): string | undefined => (error as { code?: string }).code;

  /** Today's `removeEntryWithin`: one name at a time, each folder opened without following a link and proven. */
  async function removeWithin(
    scope: S,
    through: string,
    expected: FileIdentity,
    device: bigint,
    inspect = false,
    beforeDelete?: () => Promise<void>,
  ): Promise<void> {
    if (await heldMember(scope, expected)) refuse('fenced');
    if (expected.kind !== 'directory') {
      if (!inspect) {
        await beforeDelete?.();
        await scope.fs.unlink(through);
      }
      return;
    }
    if (expected.device !== device) refuse('cross_device');
    const folder = await scope.fs.openDirectory(through).catch(() => refuse('changed'));
    try {
      if (!same(expected, folder.identity)) refuse('changed');
      const self = folder.entryPath('');
      if (self === undefined) return refuse('no_descriptor_reach');
      for (const name of await scope.fs.list(self)) {
        const child = folder.entryPath(name) as string;
        const identity = await scope.fs.identity(child);
        if (identity !== undefined) await removeWithin(scope, child, identity, device, inspect, beforeDelete);
      }
    } finally {
      await folder.close();
    }
    if (!inspect) await beforeDelete?.();
    if (!same(expected, await scope.fs.identity(through))) refuse('changed');
    if (!inspect) await scope.fs.rmdir(through);
  }

  /**
   * `removeWithin` where no path reaches a held folder (macOS): the same walk, one name at a time, but every step goes
   * through the folder's DESCRIPTOR (`FolderSteps`: `unlinkat`, and the working-directory bracket for a listing, an
   * `lstat` and an `rmdir`) and every folder below is opened from its parent's descriptor without following a link, so a
   * folder swapped for a link in the middle of the tree is refused (`changed`), never walked, and nothing outside the
   * proven folder is touched. A name that is not one plain segment is refused `outside`, as the lexical rule would.
   */
  async function removeWithinHeld(
    scope: S,
    steps: FolderSteps,
    removal: FolderRemoval,
    name: string,
    expected: FileIdentity,
    device: bigint,
    inspect = false,
    beforeDelete?: () => Promise<void>,
  ): Promise<void> {
    if (await heldMember(scope, expected)) refuse('fenced');
    if (expected.kind !== 'directory') {
      if (!inspect) {
        await beforeDelete?.();
        await steps.unlink(name).catch(error => heldFailure(error));
      }
      return;
    }
    if (expected.device !== device) refuse('cross_device');
    const child = await removal.openFolder(name).catch(() => refuse('changed'));
    try {
      if (!same(expected, child.identity)) refuse('changed');
      const inside = child.steps.removal as FolderRemoval;
      for (const member of await inside.list().catch(error => heldFailure(error))) {
        const identity = await inside.lstat(member).catch(error => heldFailure(error));
        if (identity !== undefined)
          await removeWithinHeld(scope, child.steps, inside, member, identity, device, inspect, beforeDelete);
      }
    } finally {
      await child.close();
    }
    if (!inspect) await beforeDelete?.();
    if (!same(expected, await removal.lstat(name).catch(error => heldFailure(error)))) refuse('changed');
    if (!inspect) await removal.rmdir(name).catch(error => heldFailure(error));
  }

  /** What a step through a held folder that failed means to the caller: a folder that is no longer the proven one is `changed`; anything else is the host's own error. */
  function heldFailure(error: unknown): never {
    const code = errnoOf(error);
    if (code === 'EBADF' || code === 'EBUSY') return refuse('changed');
    if (code === 'EINVAL') return refuse('outside');
    throw error;
  }

  /** `remove` of `leaf` in a checked folder through its descriptor and the bracket (the Linux walk, without a path). */
  async function removeHeld(
    scope: S,
    steps: FolderSteps,
    removal: FolderRemoval,
    leaf: string,
    onlyIfEmpty: boolean,
    expectedIdentity?: RootIdentity,
    beforeDelete?: () => Promise<void>,
  ): Promise<void> {
    const identity = await removal.lstat(leaf).catch(error => heldFailure(error));
    if (identity === undefined) return;
    if (expectedIdentity !== undefined && (identity.kind !== 'directory' || !same(expectedIdentity, identity)))
      refuse('changed');
    if (onlyIfEmpty && identity.kind === 'directory') {
      await beforeDelete?.();
      await removeEmptyFolder(() => removal.rmdir(leaf).catch(error => heldFailure(error)));
      return;
    }
    // Inspect the entire tree first: a known mount must not cost even an earlier sibling's contents.
    if (expectedIdentity !== undefined)
      await removeWithinHeld(scope, steps, removal, leaf, identity, identity.device, true);
    await removeWithinHeld(scope, steps, removal, leaf, identity, identity.device, false, beforeDelete);
  }

  /**
   * `rmdir(2)` through the checked folder: ONE syscall both looks for an entry and removes the folder, so no entry can
   * arrive between a look and the removal (a list-then-remove would have that window). Never recurses.
   */
  async function removeEmptyFolder(rmdirIt: () => Promise<void>): Promise<void> {
    try {
      await rmdirIt();
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return refuse('not_empty');
      if (code === 'ENOENT') return;
      // the name is no longer a folder (a link or a file took its place after the look)
      if (code === 'ENOTDIR') return refuse('changed');
      throw error;
    }
  }

  async function removeChecked(
    scope: S,
    full: string,
    onlyIfEmpty: boolean,
    expectedIdentity?: RootIdentity,
    beforeDelete?: () => Promise<void>,
  ): Promise<void> {
    const leaf = basename(full);
    const parent = dirname(full);
    const folder =
      full === scope.base.real
        ? await openCheckedFolder({ ...scope, base: { ...scope.base, real: parent } }, parent)
        : await openCheckedFolder(scope, parent);
    try {
      const through = folder.entryPath(leaf);
      if (through === undefined) {
        // No path reaches the folder (macOS) but the host loaded the C calls AND the working-directory bracket: the
        // whole remove, a tree included, goes through the proven folder's descriptor (`FolderSteps.removal`), as on
        // Linux, for an owner's root as for an internal one.
        const steps = folder.at;
        if (steps?.removal !== undefined) {
          await removeHeld(scope, steps, steps.removal, leaf, onlyIfEmpty, expectedIdentity, beforeDelete);
          if (expectedIdentity !== undefined) await folder.sync();
          return;
        }
        // Without that reach (S44): an owner root removes nothing, and no root removes a FOLDER, because a by-path
        // `rm -r` after one re-proof of the parent deletes an outside tree when the parent is swapped for a link in
        // between. A file or link leaf of an internal root is unlinked by path (sessions markers, tidy): the leaf is
        // looked at without following it, and `unlink` never removes a tree, so the worst a swapped parent costs is ONE
        // same-named file outside the root. Declared GAP: a host whose C library or bracket could not be loaded.
        if (scope.ownerRoot || expectedIdentity !== undefined) return refuse('no_descriptor_reach');
        const problem = await folderProblem(scope, parent, folder.identity);
        if (problem !== undefined) return refuse(problem);
        await refuseHeldName(scope, join(parent, leaf));
        const found = await scope.fs.identity(join(parent, leaf));
        if (found === undefined) return;
        if (found.kind === 'directory') return refuse('no_descriptor_reach');
        await beforeDelete?.();
        await scope.fs.unlink(join(parent, leaf));
        return;
      }
      const identity = await scope.fs.identity(through);
      if (identity === undefined) return;
      if (expectedIdentity !== undefined && (identity.kind !== 'directory' || !same(expectedIdentity, identity)))
        refuse('changed');
      if (onlyIfEmpty && identity.kind === 'directory') {
        await beforeDelete?.();
        await removeEmptyFolder(() => scope.fs.rmdir(through));
        return;
      }
      if (expectedIdentity !== undefined) await removeWithin(scope, through, identity, identity.device, true);
      await removeWithin(scope, through, identity, identity.device, false, beforeDelete);
      if (expectedIdentity !== undefined) await folder.sync();
    } finally {
      await folder.close();
    }
  }

  return removeChecked;
}

const UNSUPPORTED = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

/** A quarantine moves first, then proves what moved. No deletion occurs here, even on a failed proof. */
export function rootQuarantine<S extends RemovalScope>(checks: {
  readonly openCheckedFolder: (scope: S, real: string) => Promise<OpenedDirectory>;
  readonly heldMember: (scope: S, identity: FileIdentity) => Promise<boolean>;
  readonly refuse: (reason: RootRefusal) => never;
}): (scope: S, from: string, to: string, expected: RootIdentity) => Promise<void> {
  const { openCheckedFolder, heldMember, refuse } = checks;
  return async (scope, from, to, expected) => {
    if (dirname(from) !== dirname(to) || !/^\.fy-remove-[a-zA-Z0-9_-]+$/.test(basename(to)) || from === to)
      refuse('outside');
    const parent = await openCheckedFolder(scope, dirname(from));
    try {
      const source = basename(from);
      const target = basename(to);
      const look = async (leaf: string): Promise<FileIdentity | undefined> => {
        const through = parent.entryPath(leaf);
        if (through !== undefined) return await scope.fs.identity(through);
        if (parent.at !== undefined) return await parent.at.identity(leaf);
        return refuse('no_descriptor_reach');
      };
      const before = await look(source);
      if (before?.kind !== 'directory' || !same(expected, before)) return refuse('changed');
      if (await heldMember(scope, before)) return refuse('fenced');
      if ((await look(target)) !== undefined) return refuse('changed');
      let exclusive = parent.renameNoReplace;
      if (exclusive !== undefined) {
        try {
          await exclusive(source, parent, target);
        } catch (error) {
          if (!UNSUPPORTED.has((error as { code?: string }).code ?? '')) return refuse('changed');
          exclusive = undefined;
        }
      }
      if (exclusive === undefined) {
        process.emitWarning(
          'Worktree quarantine: exclusive rename unavailable; using descriptor-relative rename with destination precheck. A concurrent empty destination can be replaced.',
        );
        if ((await look(target)) !== undefined) return refuse('changed');
        const fromAt = parent.entryPath(source);
        const toAt = parent.entryPath(target);
        if (fromAt !== undefined && toAt !== undefined)
          await scope.fs.rename(fromAt, toAt).catch(() => refuse('changed'));
        else if (parent.at !== undefined)
          await parent.at.renameInto(source, parent, target).catch(() => refuse('changed'));
        else return refuse('no_descriptor_reach');
      }
      const moved = await look(target);
      if (moved?.kind !== 'directory' || !same(expected, moved)) {
        // A plain rename back could replace a newly arrived original. Only an atomic exclusive restore is safe.
        if (exclusive !== undefined) await exclusive(target, parent, source).catch(() => undefined);
        await parent.sync();
        return refuse('changed');
      }
      await parent.sync();
    } finally {
      await parent.close();
    }
  };
}
