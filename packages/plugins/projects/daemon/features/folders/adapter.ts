import type { HeldRoot, KernelPorts, RootHandle } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { holdsSignIn } from './fence.ts';
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
 * nothing.
 *
 * GAP (stated, not closed): the held descriptor fixes the folder's IDENTITY, not its LOCATION. The home and private
 * checks judge a path snapshot (the real path as it was when asked); ancestor sign-in markers are looked up by path;
 * and the rollback `rmdir` is one validated leaf name run in the held folder. A rename between those steps can
 * therefore move where a held folder sits. Only a process already running as THIS user on THIS machine can win that
 * race, and it can read `~/.ssh` directly, so the route adds nothing for it. At the most it gets a listing of, or one
 * empty `0700` folder made inside, a folder it could already reach. The fence exists to stop a REMOTE caller using the
 * route to see or create inside private folders, and it does.
 *
 * Sign-in markers and private names are judged by ONE fold (`foldName` in `fence.ts`: case, NFKD, marks and invisible
 * code points dropped) wherever they are looked at: the listed folder, each listed child, each ancestor below the home,
 * the write parent and the destination. Nothing is said about a path until its real path has been judged inside the
 * home: what is not yet verified answers one `folder_refused`.
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

  /**
   * Whether the real path `path` is a file: only asked AFTER its real path was judged inside the home, and only to tell
   * a file there from a refusal. Everything else (a folder that could not be held, nothing at all, a refusal) is one
   * "refused", so nothing not yet verified is described.
   */
  const isFile = async (path: string): Promise<boolean> => {
    const root = handle(path);
    const fenced = root.resolve('');
    if (!fenced.ok) return false;
    try {
      const stat = await root.stat(fenced.value);
      return stat !== undefined && stat.kind !== 'directory';
    } catch {
      return false;
    }
  };

  /** What is at `<folder>/<name>`, the leaf not followed. A name the root refuses is not one to make over: a link. */
  const leafAt = async (folder: string, name: string): Promise<'missing' | 'link' | 'present'> => {
    const root = handle(folder);
    const fenced = root.resolve(name);
    if (!fenced.ok) return 'link';
    try {
      const found = await root.lstat(fenced.value);
      if (found === undefined) return 'missing';
      return found.kind === 'symlink' ? 'link' : 'present';
    } catch {
      return 'link';
    }
  };
  const exists = async (folder: string, name: string): Promise<boolean> => (await leafAt(folder, name)) !== 'missing';

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
    const root = handle(reached);
    const fenced = root.resolve('');
    if (!fenced.ok) return { ok: false, reason: 'refused' };
    let pinned: HeldRoot;
    try {
      pinned = await root.pin(fenced.value, { fence: 'none' });
    } catch {
      // Not held. Only a path that STILL reaches the very real path the home verdict passed, and is a file, is said to be
      // one; anything else (a swap, a refusal, nothing there) is the one refusal.
      const same = (await realOf(reached)) === reached;
      return { ok: false, reason: same && (await isFile(reached)) ? 'not_folder' : 'refused' };
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
      lookup: name => leafAt(pinned.rootReal, name),
      readText: async (rel, limit) => {
        // Looked at without following the leaf first (as `lookup`), then read through the held descriptor, whose walk
        // refuses a link at ANY component and which answers only a regular file.
        if ((await leafAt(pinned.rootReal, rel)) !== 'present') return undefined;
        try {
          const target = await pinned.open(rel);
          try {
            if (target.metadata.type !== 'file') return undefined;
            const bytes = await target.read(limit);
            return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
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
      device: async rel => {
        const identity = await identityAt(pinned, rel);
        return identity === undefined ? undefined : identity.slice(0, identity.indexOf(':'));
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
    leaf: async path => {
      const trimmed = path.replace(/\/+$/, '');
      const at = trimmed.lastIndexOf('/');
      if (trimmed === '' || at < 0) return 'present';
      return leafAt(at === 0 ? '/' : trimmed.slice(0, at), trimmed.slice(at + 1));
    },
    realPaths: async paths => {
      const real = await Promise.all(paths.map(realOf));
      return real.filter((path): path is string => path !== undefined);
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
      try {
        // Every name the folder holds, a link included, judged by the SAME fold as everywhere else (`fence.ts`): a marker
        // spelled `ID_RSA`, `Auth.JSON` or in full-width letters is a marker.
        return holdsSignIn(await root.list(self.value));
      } catch {
        // What cannot be read is not proved free of one.
        return true;
      }
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
