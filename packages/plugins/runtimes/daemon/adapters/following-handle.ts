/**
 * The READ-ONLY handle Runtimes uses on an account home outside the fleet (an operator's own folder, a home-manager
 * home): it follows a link ONLY when the link resolves INSIDE that account home. It serves the SKILLS of such a home; the
 * three documents follow a link out of the home through `document-link.ts`, under their own bounds.
 *
 * THE ROOT IS THE ACCOUNT HOME, never `/`. The kernel's `harness-home` root is scoped to the home (`anchor`): it resolves a
 * link before it checks it and refuses one that leaves the home (`link_escape`). A link whose real path is outside the home
 * is therefore SKIPPED (today's session skill picker followed it; today's machine inventory skipped it, as did the
 * fallback home's reader: a folder whose `realpath` was not inside the confinement was passed over with no line and no
 * error). A link into a store, into `~/.ssh`, or into any other place outside the home stays a LINK in the listing, which
 * every skill reader treats as "not read".
 * The kernel's judgement still holds at every step: nothing inside the daemon's own home is reached (`fenced`), a device
 * file is refused, a file with a second hard link is refused, and the root is READ-ONLY (the handle exposes no member that
 * writes, removes, renames or links, and the root under it would refuse one).
 *
 * WHAT THIS FILE ADDS, each a sentence:
 *
 *  - a sign-in file (`.credentials.json`, `auth.json`) is never listed, and a read refuses one, whatever name a link gives
 *    it and wherever inside the home the link leads (its real path's name is judged, case-insensitively), the same list
 *    `host-harness-scan.ts` keeps;
 *  - a link whose real path is the folder it is found in, or a folder above it (`skills/self -> skills`, `dir/up -> ..`),
 *    is a loop and is left as a link;
 *  - a chain of links that never ends in a file or folder (longer than the operating system's own bound), a link to
 *    nothing, and a link the kernel refuses all stay a LINK in the listing.
 *
 * HOW FAR A LINK IS FOLLOWED is bounded by construction, not by a count: `follow` is on only for the listing of the home and
 * of its `skills/` folder (a WIDENING from today's machine inventory, which followed none of them in a home outside the
 * fleet), and the folder a link leads to is then read with `follow` off, where every link is reported as a link and none
 * is opened (today's skill-folder reader). So a chain of followed links is
 * at most three: the `skills` link, the entry link, and the `SKILL.md` link (`skillManifest` only), plus the link a document
 * is; whatever chain of links each is made of, the chain itself is resolved by the kernel.
 *
 * WHAT A READ RETURNS. A read judges the REAL path of the name (inside the home, and its own name is not a sign-in file's,
 * any case), reads the real path through the kernel's held descriptor, and hands the bytes back only when the NAME of that
 * real path still reaches the very file that was opened (`stillNames`, by device and inode); anything else is refused and
 * the bytes are dropped. With `follow` off the real path must also be the lexical path (no link anywhere in it), as the
 * inventory of today opened a skill file (`O_NOFOLLOW` leaf, parent checked). So a name swapped for a link between the
 * judgement and the read, to a sign-in file or to anything else, is refused, never returned. What is not covered: a folder
 * ABOVE the file swapped for a link to another folder inside the same home can make the read return a file of the SAME
 * name there (never a sign-in file's name, never outside the home, never the daemon's home).
 */
import { basename, join, relative, sep } from 'node:path';
import type { FencedPath, RootEntry, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { isSignInName } from '../lib/account/credentials.ts';

/** A harness's own sign-in file (the one list in `account/credentials.ts`): never listed, never read. */
const isSignIn = isSignInName;

/** The members of a root the reader uses: none of them writes, and the type names no other. */
export interface ReadHandle {
  resolve: RootHandle['resolve'];
  entries(path: FencedPath): Promise<readonly RootEntry[]>;
  readText(path: FencedPath, limitBytes?: number): Promise<string>;
  readBytes(path: FencedPath, limitBytes?: number): Promise<Uint8Array>;
}

const refused = (): Error => new Error('the file is not read (a sign-in file, or not the file that was judged)');

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

  /** `entry`, a link in `directory` (whose real path is `here`), as what it leads to inside the home; the link otherwise. */
  const followed = async (directory: string, here: string | undefined, entry: RootEntry): Promise<RootEntry> => {
    const target = await real(join(directory, entry.name));
    if (target === undefined || isSignIn(basename(target))) return entry;
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

  /**
   * The bytes of `path`: judged by real path, read through the real path, kept only when the real path's name still reaches
   * the file that was opened. With `follow` off no link may be anywhere in the path.
   */
  const checked = async (path: FencedPath, limitBytes?: number): Promise<Uint8Array> => {
    const target = await real(path);
    if (target === undefined || isSignIn(basename(target))) throw refused();
    if (!follow) {
      const here = await real(folder);
      if (here === undefined || target !== join(here, relative(folder, path))) throw refused();
    }
    const placed = at(target);
    if (!placed.ok) throw refused();
    const bytes = await reach.readDurable(placed.value, limitBytes, async held =>
      (await held.stillNames()) ? held.bytes : undefined,
    );
    if (bytes === undefined) throw refused();
    return bytes;
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
      if (!follow || !listed.some(entry => entry.kind === 'symlink')) return listed;
      // The folder's own real path, once for the whole listing (not once per link).
      const here = await real(path);
      return await Promise.all(
        listed.map(async entry => (entry.kind === 'symlink' ? await followed(path, here, entry) : entry)),
      );
    },
    readText: async (path: FencedPath, limitBytes?: number) =>
      new TextDecoder().decode(await checked(path, limitBytes)),
    readBytes: async (path: FencedPath, limitBytes?: number) => await checked(path, limitBytes),
  });
}

/**
 * Whether the ONE name `path` (a skill folder's `SKILL.md`) is, or leads inside the home `anchor` to, a plain file with a
 * single name that is not a sign-in file. It resolves that one name (resolve, real path, one `lstat`) and lists nothing, so
 * a farm of links to a big folder costs the same per link as a plain skill. A `SKILL.md` that is a hard link is NOT
 * listed (the kernel never reads one; the inventory of today listed it and then read it).
 */
export async function isPlainFileInside(
  roots: Pick<RootsPort, 'root'>,
  anchor: string,
  path: string,
): Promise<boolean> {
  const reach = roots.root('harness-home', { subfolder: anchor });
  const placed = reach.resolve(path);
  if (!placed.ok) return false;
  const target = await reach.realPath(placed.value).catch(() => undefined);
  if (target === undefined || isSignIn(basename(target))) return false;
  const at = reach.resolve(target);
  if (!at.ok) return false;
  const found = await reach.lstat(at.value).catch(() => undefined);
  return found?.kind === 'file' && found.links <= 1;
}
