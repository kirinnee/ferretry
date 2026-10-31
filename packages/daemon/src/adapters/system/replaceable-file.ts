import { lstat, readlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute } from 'node:path';

/**
 * The folders a program is trusted from: system folders this account cannot fill. A program counts only when the
 * file it runs IS what one of these resolves `<folder>/<name>` to (the code exception, the secret card's program, and
 * a `/nix/store` program secure copy found). Never a raw store path (any user can `nix-store --add` a shell copy at
 * `<hash>/bin/ssh`) and never a profile the account builds itself (`~/.nix-profile`, whose link this account owns).
 * `/etc/profiles/per-user/<account>/bin` is the per-user profile a SYSTEM activation (nix-darwin, NixOS) builds as
 * root. Every folder still has to pass {@link replaceableBy} like any other path: one this account owns or anyone may
 * write (`/usr/local/bin` under Homebrew) proves nothing.
 */
export const ROOT_PROGRAM_FOLDERS: readonly string[] = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/usr/local/bin',
  '/run/current-system/sw/bin',
  '/nix/var/nix/profiles/default/bin',
  ...perUserProfile(),
];

/** The Nix store: owned by root, yet ANY user may add a path to it through the daemon. Ownership proves nothing here. */
const NIX_STORE = '/nix/store/';

/** What {@link replaceableBy} looks at on the disk. The real file system unless a test gives another. */
export interface ReplaceableDisk {
  lstat(path: string): Promise<{ readonly uid: number; readonly mode: number; isSymbolicLink(): boolean }>;
  readlink(path: string): Promise<string>;
}

const DISK: ReplaceableDisk = { lstat, readlink };
/** Links followed before a path is given up on as replaceable; the kernel's own limit is 40. */
const MAX_LINKS = 40;

/**
 * Whether this account could change the program or put another in its place. OWNERSHIP, not today's permission
 * bits: an owner can `chmod` its way back in. A ferret runs as this same account, so the program counts as
 * replaceable when any part of the path, up to `/`, is owned by this account (a link it could repoint, a folder it
 * could fill), or is a folder anyone may write without the sticky bit. A part that cannot be looked at counts as
 * replaceable, and so does a relative path.
 *
 * EVERY HOP is checked, not only the path as found and the file at the end: the path is walked one part at a time as
 * the kernel walks it, and each link on the way, a file's or a folder's, is checked and then followed. A root-owned
 * `/usr/bin/ssh` that points through `/home/u/link` is replaceable, because the account can repoint the link in the
 * middle.
 *
 * A real file in the NIX STORE is root-owned whoever put it there, so it counts as replaceable unless a root-controlled
 * bin folder ({@link ROOT_PROGRAM_FOLDERS}) leads to it: `<folder>/<its name>` walks to that very file through parts
 * this account cannot change. Reached only through `~/.nix-profile`, or named directly, it is the account's own.
 */
export async function replaceableBy(
  account: number | undefined,
  file: string,
  disk: ReplaceableDisk = DISK,
  folders: readonly string[] = ROOT_PROGRAM_FOLDERS,
): Promise<boolean> {
  const real = await walked(account, file, disk);
  if (real === undefined) return true;
  if (real.startsWith(NIX_STORE)) return !(await reachedFromRootFolder(account, real, disk, folders));
  return false;
}

/**
 * The real path `file` leads to, walked one part at a time and every link followed by hand, or `undefined` when any
 * part on the way is one this account could change, cannot be looked at, or the links do not end.
 */
async function walked(account: number | undefined, file: string, disk: ReplaceableDisk): Promise<string | undefined> {
  if (!isAbsolute(file) || replaceablePart(account, await disk.lstat('/').catch(() => undefined))) return undefined;
  // `done` is a real folder path with no link in it ('' is `/`), so a `..` after it is its parent.
  let done = '';
  let rest = file.split('/');
  let links = 0;
  while (rest.length > 0) {
    const [part = '', ...after] = rest;
    rest = after;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      done = dirname(done === '' ? '/' : done);
      if (done === '/') done = '';
      continue;
    }
    const next = `${done}/${part}`;
    const status = await disk.lstat(next).catch(() => undefined);
    if (status === undefined || replaceablePart(account, status)) return undefined;
    if (!status.isSymbolicLink()) {
      done = next;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return undefined;
    const target = await disk.readlink(next).catch(() => undefined);
    if (target === undefined) return undefined;
    if (isAbsolute(target)) done = '';
    rest = [...target.split('/'), ...rest];
  }
  return done === '' ? '/' : done;
}

/** One part of a path: missing, owned by this account, or a folder anyone may write without the sticky bit. */
function replaceablePart(
  account: number | undefined,
  status: Awaited<ReturnType<ReplaceableDisk['lstat']>> | undefined,
): boolean {
  if (status === undefined) return true;
  if (account !== undefined && status.uid === account) return true;
  const openToOthers = (status.mode & 0o022) !== 0 && (status.mode & 0o1000) === 0;
  // A symlink's own mode is always open and means nothing; what it names is walked next.
  return openToOthers && !status.isSymbolicLink();
}

/** Some root-controlled folder's entry of the same name walks to `real`, through parts this account cannot change. */
async function reachedFromRootFolder(
  account: number | undefined,
  real: string,
  disk: ReplaceableDisk,
  folders: readonly string[],
): Promise<boolean> {
  for (const folder of folders) if ((await walked(account, `${folder}/${basename(real)}`, disk)) === real) return true;
  return false;
}

/** `/etc/profiles/per-user/<account>/bin`, when this account has a name. */
function perUserProfile(): readonly string[] {
  try {
    const name = userInfo().username;
    return /^[A-Za-z0-9._-]+$/u.test(name) ? [`/etc/profiles/per-user/${name}/bin`] : [];
  } catch {
    return [];
  }
}
