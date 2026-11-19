import { FsError, type HeldRoot, type KernelPorts, type RootHandle } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { SIGN_IN_FILES } from './fence.ts';
import type { FolderBrowser, FolderOpen, FolderVerdict, HeldFolder, LeafMade, RawFolderEntry } from './port.ts';

type Kernel = Pick<KernelPorts, 'roots' | 'paths' | 'spawn'>;

const EPOCH = '1970-01-01T00:00:00.000Z' as Instant;
const instantOf = (text: string | undefined): Instant => {
  const at = text === undefined ? Number.NaN : Date.parse(text);
  return (Number.isNaN(at) ? EPOCH : new Date(at).toISOString()) as Instant;
};

/**
 * The explorer's machine reads, through the kernel's `imports` root only: it refuses Ferretry's own home, resolves
 * links and refuses device files. Names, kinds and times come back; no file is ever opened.
 *
 * A folder is never read, listed or made in by its NAME twice. It is resolved once under the real home, held OPEN
 * (`RootHandle.pin`: a descriptor, no link followed beneath it), the held object's own real path is judged again, and
 * the listing and the one `mkdir` go through that held object, so a name swapped for a link a moment later reaches
 * nothing. The GAP that remains is written in the PR body.
 */
export function kernelBrowser(kernel: Kernel): FolderBrowser {
  const handle = (folder: string): RootHandle => kernel.roots.root('imports', { subfolder: folder });

  /**
   * The real path of an existing name, links resolved; `undefined` for anything that does not resolve (a missing name, a
   * dangling link, a refusal): the caller says only "refused", because telling those apart before the real path is judged
   * would tell what exists outside the home.
   */
  const realOf = async (path: string): Promise<string | undefined> => {
    const root = handle(path);
    const fenced = root.resolve('');
    if (!fenced.ok) return undefined;
    try {
      return await root.realPath(fenced.value);
    } catch {
      return undefined;
    }
  };

  /** What the real folder `path` is: only asked once its real path has been judged inside the home. */
  const kindOf = async (path: string): Promise<'folder' | 'missing' | 'not_folder' | 'refused'> => {
    const root = handle(path);
    const fenced = root.resolve('');
    if (!fenced.ok) return 'refused';
    try {
      const stat = await root.stat(fenced.value);
      if (stat === undefined) return 'missing';
      return stat.kind === 'directory' ? 'folder' : 'not_folder';
    } catch {
      return 'refused';
    }
  };

  const exists = async (folder: string, name: string): Promise<boolean> => {
    const root = handle(folder);
    const fenced = root.resolve(name);
    if (!fenced.ok) return true;
    try {
      return (await root.lstat(fenced.value)) !== undefined;
    } catch {
      // A name the root refuses is not one to make over either.
      return true;
    }
  };

  /** Resolves, judges, holds, and judges what is really held. */
  const hold = async (
    path: string,
    verdict: FolderVerdict,
  ): Promise<{ ok: true; pinned: HeldRoot } | { ok: false; reason: Exclude<FolderOpen, { ok: true }>['reason'] }> => {
    const reached = await realOf(path);
    if (reached === undefined) return { ok: false, reason: 'refused' };
    // By the real path, before anything is held: a folder out of the home answers like one that is not there.
    const first = await verdict(reached);
    if (first !== undefined) return { ok: false, reason: first };
    // Only now, inside the home, is what it is worth saying: a file or nothing at all.
    const kind = await kindOf(reached);
    if (kind !== 'folder') return { ok: false, reason: kind };
    const root = handle(reached);
    const fenced = root.resolve('');
    if (!fenced.ok) return { ok: false, reason: 'refused' };
    let pinned: HeldRoot;
    try {
      pinned = await root.pin(fenced.value, { fence: 'none' });
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof FsError && error.code === 'not_a_directory' ? 'not_folder' : 'refused',
      };
    }
    // The object actually held, not the name that was judged: a swap between the two lands here.
    const second = await verdict(pinned.rootReal);
    if (second !== undefined) {
      await pinned.close().catch(() => undefined);
      return { ok: false, reason: second };
    }
    return { ok: true, pinned };
  };

  const heldFolder = (pinned: HeldRoot): HeldFolder => {
    const inside = <T>(program: string, args: readonly string[], then: (exitCode: number | null) => T): Promise<T> =>
      kernel.spawn.run(program, args, { cwd: pinned.policyCwd }).then(done => then(done.exitCode));
    return {
      real: pinned.rootReal,
      entries: async limit => {
        try {
          const target = await pinned.open('', { wantDirectory: true });
          try {
            const listing = await target.list(limit);
            const entries: RawFolderEntry[] = [];
            for (const entry of listing.entries) {
              if (entry.type === 'symlink') continue;
              entries.push({
                name: entry.name,
                kind: entry.type === 'dir' ? 'directory' : 'file',
                modified: instantOf(entry.mtime),
              });
            }
            return { entries, more: listing.truncated };
          } finally {
            await target.close();
          }
        } catch {
          return undefined;
        }
      },
      hasGit: async name => {
        try {
          const target = await pinned.open(`${name}/.git`);
          await target.close();
          return true;
        } catch {
          return false;
        }
      },
      makeLeaf: async (name, verdict): Promise<LeafMade> => {
        let made: boolean;
        try {
          // Not `-p`: one level, and an existing name (a link included) is a failure, never an overwrite.
          made = await inside('mkdir', ['-m', '700', '--', name], code => code === 0);
        } catch {
          return { kind: 'failed' };
        }
        if (!made) return (await exists(pinned.rootReal, name)) ? { kind: 'exists' } : { kind: 'failed' };
        const target = `${pinned.rootReal === '/' ? '' : pinned.rootReal}/${name}`;
        // What the new folder really is: the object in the held parent, and what its path reaches now, must be one folder.
        const held = await identityAt(pinned, name);
        const byPath = held === undefined ? undefined : await hold(target, verdict);
        let refusal: 'outside' | 'private' | undefined = held === undefined ? 'outside' : undefined;
        if (byPath !== undefined) {
          if (!byPath.ok) refusal = byPath.reason === 'private' ? 'private' : 'outside';
          else {
            try {
              const same = byPath.pinned.rootReal === target && (await identityAt(byPath.pinned, '')) === held;
              if (!same) refusal = 'outside';
            } finally {
              await byPath.pinned.close().catch(() => undefined);
            }
          }
        }
        if (refusal === undefined) return { kind: 'made', path: target };
        // Take back only the folder this call made: `rmdir` refuses anything that holds an entry.
        await inside('rmdir', ['--', name], () => undefined).catch(() => undefined);
        return { kind: 'refused', reason: refusal };
      },
      close: async () => {
        await pinned.close().catch(() => undefined);
      },
    };
  };

  return {
    home: async () => {
      const home = kernel.paths.home();
      return (await realOf(home)) ?? home;
    },
    open: async (path, verdict) => {
      const held = await hold(path, verdict);
      return held.ok ? { ok: true, folder: heldFolder(held.pinned) } : held;
    },
    holdsSignIn: async path => {
      const root = handle(path);
      // Not a folder the root will answer for (a file, a refusal): nothing to hold a sign-in, and opening it is refused anyway.
      const self = root.resolve('');
      if (!self.ok) return false;
      try {
        if ((await root.stat(self.value))?.kind !== 'directory') return false;
      } catch {
        return false;
      }
      for (const name of SIGN_IN_FILES) {
        const fenced = root.resolve(name);
        // A name the root will not answer for is not proved absent.
        if (!fenced.ok) return true;
        try {
          if ((await root.lstat(fenced.value)) !== undefined) return true;
        } catch {
          return true;
        }
      }
      return false;
    },
  };
}

/** The device and inode of the folder `rel` reaches inside a held folder (`''` is the held folder itself); a link refused. */
async function identityAt(pinned: HeldRoot, rel: string): Promise<string | undefined> {
  try {
    const target = await pinned.open(rel, { wantDirectory: true });
    try {
      const leaf = target.identities.at(-1);
      return leaf === undefined ? undefined : `${leaf.dev}:${leaf.ino}`;
    } finally {
      await target.close();
    }
  } catch {
    return undefined;
  }
}
