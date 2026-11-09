/**
 * The READ-ONLY handle Runtimes uses on an account home outside the fleet (an operator's own folder, a home-manager
 * home): it follows a link ONLY when the link resolves INSIDE that account home.
 *
 * THE ROOT IS THE ACCOUNT HOME, never `/`. The kernel's `harness-home` root is scoped to the home (`anchor`): it resolves a
 * link before it checks it and refuses one that leaves the home (`link_escape`). A link whose real path is outside the home
 * is therefore SKIPPED, exactly as the inventory of today skipped it (`node-skill-files.ts`: a folder whose `realpath` is
 * not inside the home is passed over with no line and no error). A link into a store, into `~/.ssh`, or into any other
 * place outside the home is skipped the same way: it stays a LINK in the listing, which every reader treats as "not read".
 * The kernel's judgement still holds at every step: nothing inside the daemon's own home is reached (`fenced`), a device
 * file is refused, a file with a second hard link is refused, and the root is READ-ONLY (the handle exposes no member that
 * writes, removes, renames or links, and the root under it would refuse one).
 *
 * WHAT THIS FILE ADDS, each a sentence:
 *
 *  - a sign-in file (`.credentials.json`, `auth.json`) is never listed or read, whatever name a link gives it and
 *    wherever inside the home the link leads (its real path is judged, case-insensitively), the same list
 *    `host-harness-scan.ts` keeps;
 *  - a link whose real path is the folder it is found in, or a folder above it (`skills/self -> skills`, `dir/up -> ..`),
 *    is a loop and is left as a link;
 *  - a chain of links that never ends in a file or folder (longer than the operating system's own bound), a link to
 *    nothing, and a link the kernel refuses all stay a LINK in the listing.
 *
 * HOW FAR A LINK IS FOLLOWED is bounded by construction, not by a count: `follow` is on only for the listing of the home and
 * of its `skills/` folder (what the inventory of today did), and the folder a link leads to is then read with `follow` off,
 * where every link is reported as a link and none is opened (today's skill-folder reader). So a followed link is at most the
 * `skills` link and one entry link, whatever chain of links each is made of, and the chain itself is resolved by the kernel.
 *
 * Declared residual: a name swapped for a link between the listing and the read can reach any file inside the SAME home
 * that the kernel would have let a followed link reach (never the daemon's home, never a sign-in file), read once and
 * bounded by the caller's limit.
 */
import { basename, join, relative, sep } from 'node:path';
import type { FencedPath, RootEntry, RootHandle, RootsPort } from '@ferretry/kernel/contract';

/** Names of a harness's own sign-in files (the list `host-harness-scan.ts` keeps): never listed, never read. */
const SIGN_IN_FILES = new Set(['.credentials.json', 'auth.json']);

const isSignIn = (name: string): boolean => SIGN_IN_FILES.has(name.toLowerCase());

/** The members of a root the reader uses: none of them writes, and the type names no other. */
export type ReadHandle = Pick<RootHandle, 'resolve' | 'entries' | 'readText' | 'readBytes'>;

const refused = (): Error => new Error('a sign-in file is never read');

/** A name that tries to leave the folder the handle is for. */
const outside = { ok: false, error: 'outside' } as const;

/**
 * The handle the reader holds for `folder`, which lies at or below the account home `anchor`. `follow` says whether a link
 * in a listing is followed (when it resolves inside the home) or reported as a link.
 */
export function followingHandle(
  roots: Pick<RootsPort, 'root'>,
  anchor: string,
  folder: string,
  follow: boolean,
): ReadHandle {
  const reach = roots.root('harness-home', { subfolder: anchor });
  const at = (path: string) => reach.resolve(path);
  /** The real path of `path`, or `undefined` when it leads nowhere, loops or leaves the home. */
  const real = async (path: string): Promise<string | undefined> => {
    const placed = at(path);
    if (!placed.ok) return undefined;
    return await reach.realPath(placed.value).catch(() => undefined);
  };

  /** `entry`, a link in `directory`, as what it leads to when that is inside the home; the link itself otherwise. */
  const followed = async (directory: string, entry: RootEntry): Promise<RootEntry> => {
    const target = await real(join(directory, entry.name));
    if (target === undefined || isSignIn(basename(target))) return entry;
    const here = await real(directory);
    // A link to this folder or to one above it is a loop.
    if (here === undefined || here === target || here.startsWith(`${target}${sep}`)) return entry;
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
      links: found.links,
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
      if (!follow) return listed;
      return await Promise.all(
        listed.map(async entry => (entry.kind === 'symlink' ? await followed(path, entry) : entry)),
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
