/**
 * The READ-ONLY handle Runtimes uses on an account home outside the fleet (an operator's own folder, a home-manager
 * home): it follows the links that are inside the home, because such a home is made of them (`skills/`, `settings.json`
 * are links into `/nix/store`), and it follows them with bounds.
 *
 * HOW A LINK IS FOLLOWED WITH NO KERNEL `readlink`. The kernel's `harness-home` root resolves a link before it checks it,
 * and refuses one that leaves the folder the root is scoped to. So the handle here is scoped to `/`: where a link leads is
 * then answered by `realPath` (the kernel's own resolution of the whole chain), and nothing is judged by this file but
 * what the kernel cannot judge. The kernel's judgement still holds for every target, at every hop:
 *
 *  - nothing inside the daemon's own home is reached (`fenced`, by name, by identity and on every link hop), so a link
 *    from an operator's home to `~/.ferretry` state, a secret, or another runtime's home in the fleet is not followed;
 *  - a device file is refused, and a file with a second hard link is refused unless it sits in a store closed to this
 *    process (`/nix/store`), which is why a store file is read and a planted hard link is not;
 *  - the root is `harness-home`, a READ-ONLY root: the handle exposes no member that writes, removes, renames or links,
 *    and the root it sits on would refuse one (`read_only`).
 *
 * WHAT THIS FILE ADDS, each a sentence:
 *
 *  - a sign-in file (`.credentials.json`, `auth.json`) is never listed or read, whatever name a link gives it and
 *    wherever the link leads (its real path is judged, case-insensitively), the same list `host-harness-scan.ts` keeps;
 *  - a link is followed through at most {@link MAX_LINK_HOPS} links on the way from the home to the folder being read
 *    (a link to a folder that holds a link to a folder, and so on); a deeper one is left as a link;
 *  - a link whose real path is the folder it is found in, or any folder above it on the way (`a -> b -> a`, `dir/self ->
 *    .`), is a loop and is left as a link, so a walk of it ends;
 *  - a chain of links that never ends in a file or folder (`a -> b -> a` as plain links, more than the operating
 *    system's own bound), a link to nothing, and a link the kernel refuses all stay a LINK in the listing, which every
 *    reader treats as "not read" and says so.
 *
 * Declared residual: a name swapped for a link between the listing and the read can reach any file the kernel would have
 * let a followed link reach (never the daemon's home, never a sign-in file), read once and bounded by the caller's limit.
 */
import { basename, join, relative, sep } from 'node:path';
import type { FencedPath, RootEntry, RootHandle, RootsPort } from '@ferretry/kernel/contract';

/** The most links followed on the way from the home down to the folder a listing is made of. */
export const MAX_LINK_HOPS = 8;

/** Names of a harness's own sign-in files (the list `host-harness-scan.ts` keeps): never listed, never read. */
const SIGN_IN_FILES = new Set(['.credentials.json', 'auth.json']);

const isSignIn = (name: string): boolean => SIGN_IN_FILES.has(name.toLowerCase());

/** The members of a root the reader uses: none of them writes, and the type names no other. */
export type ReadHandle = Pick<RootHandle, 'resolve' | 'entries' | 'readText' | 'readBytes'>;

const refused = (): Error => new Error('a sign-in file is never read');

/** A name that tries to leave the folder the handle is for. */
const outside = { ok: false, error: 'outside' } as const;

/** The handle the reader holds for `folder`, which lies at or below the account home `anchor`. */
export function followingHandle(roots: Pick<RootsPort, 'root'>, anchor: string, folder: string): ReadHandle {
  const reach = roots.root('harness-home', { subfolder: '/' });
  const at = (path: string) => reach.resolve(path);
  const real = async (path: string): Promise<string | undefined> => {
    const placed = at(path);
    if (!placed.ok) return undefined;
    return await reach.realPath(placed.value).catch(() => undefined);
  };

  /** Links met on the way from the anchor to `path`, and the real paths of every folder on it. */
  const wayTo = async (
    path: string,
  ): Promise<{ readonly hops: number; readonly chain: readonly string[] } | undefined> => {
    const down = relative(anchor, path);
    if (down === '..' || down.startsWith(`..${sep}`)) return undefined;
    const chain: string[] = [];
    let hops = 0;
    let current = anchor;
    for (const part of down === '' ? [] : down.split(sep)) {
      const here = await real(current);
      if (here === undefined) return undefined;
      chain.push(here);
      current = join(current, part);
      const placed = at(current);
      if (!placed.ok) return undefined;
      const info = await reach.lstat(placed.value).catch(() => undefined);
      if (info === undefined) return undefined;
      if (info.kind === 'symlink') hops += 1;
    }
    const last = await real(current);
    if (last === undefined) return undefined;
    chain.push(last);
    return { hops, chain };
  };

  const followed = async (
    directory: string,
    entry: RootEntry,
    way: { readonly hops: number; readonly chain: readonly string[] } | undefined,
  ): Promise<RootEntry> => {
    if (way === undefined || way.hops >= MAX_LINK_HOPS) return entry;
    const target = await real(join(directory, entry.name));
    if (target === undefined || isSignIn(basename(target))) return entry;
    // A link to this folder or to one above it on the way is a loop.
    if (way.chain.some(folderOnWay => folderOnWay === target || folderOnWay.startsWith(`${target}/`))) return entry;
    const placed = at(target);
    if (!placed.ok) return entry;
    const found = await reach.stat(placed.value).catch(() => undefined);
    if (found === undefined) return entry;
    return {
      name: entry.name,
      kind: found.kind,
      size: found.size,
      modified: found.modified,
      mode: found.mode,
      // A file reached through a link is judged for a second name by the kernel's read alone: it admits one only in a
      // store closed to this process (`/nix/store`, which hard links identical files) and refuses it anywhere else.
      links: found.kind === 'file' ? 1 : found.links,
    };
  };

  const judged = async (path: FencedPath): Promise<void> => {
    const target = await real(path);
    if (target === undefined || isSignIn(basename(target))) throw refused();
  };

  return Object.freeze({
    resolve: (relativePath: string) => {
      if (relativePath.includes('\0') || relativePath.split('/').includes('..')) return outside;
      const full = join(folder, relativePath);
      const inside = relative(folder, full);
      return inside === '..' || inside.startsWith(`..${sep}`) ? outside : at(full);
    },
    entries: async (path: FencedPath): Promise<readonly RootEntry[]> => {
      const listed = (await reach.entries(path)).filter(entry => !isSignIn(entry.name));
      if (!listed.some(entry => entry.kind === 'symlink')) return listed;
      const way = await wayTo(path);
      return await Promise.all(
        listed.map(async entry => (entry.kind === 'symlink' ? await followed(path, entry, way) : entry)),
      );
    },
    readText: async (path: FencedPath, limitBytes?: number) => {
      await judged(path);
      return await reach.readText(path, limitBytes);
    },
    readBytes: async (
      path: FencedPath,
      limitOrWindow?: number | { readonly offset: number; readonly length: number },
    ) => {
      await judged(path);
      return await reach.readBytes(path, limitOrWindow);
    },
  });
}
