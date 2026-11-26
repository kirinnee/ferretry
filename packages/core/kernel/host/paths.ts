import { err, ok, type Result } from '@ferretry/std';
import { basename, dirname, isAbsolute } from 'node:path';
import {
  isPackageProgramPath,
  type CheckedDirectory,
  type DirectoryRefusal,
  type PathsPort,
} from '../contract/ports.ts';
import type { HostFs } from './adapters/node-fs.ts';
import { fencedReal, fenceOf, sameObject, walkPhysically, walkUnchanged } from './fence-guard.ts';
import type { TruncationWatcher } from './fence-index.ts';
import { mayReadOverride } from './which.ts';

/** System programs, plus the client beside this running daemon. Never executes a probe. */
export async function bindProgram(
  fs: Pick<HostFs, 'realpath' | 'identity' | 'writable'>,
  path: string,
  install?: { readonly executable: string; readonly client: string; readonly daemon: string },
) {
  const trusted = async (named: string, ownClient = false) => {
    if (!isAbsolute(named)) return undefined;
    const real = await fs.realpath(named);
    // A planted `fy -> /bin/sh` is still a planted client: system ownership alone would trust the interpreter.
    if (basename(real) !== basename(named)) return undefined;
    const file = await fs.identity(real);
    if (file?.kind !== 'file' || (file.mode & 0o111) === 0) return undefined;
    // The product client uses its own daemon install; gh/git additionally support fixed package-manager installs.
    let sibling = false;
    if (ownClient && install && basename(named) === install.client) {
      const daemon = await fs.realpath(install.executable);
      const running = await fs.identity(daemon);
      sibling =
        (basename(daemon) === install.daemon || basename(daemon) === install.client) &&
        running?.kind === 'file' &&
        dirname(real) === dirname(daemon) &&
        basename(real) === install.client;
    }
    const packaged = isPackageProgramPath(real);
    for (let at = real; !sibling && !packaged; at = dirname(at)) {
      const found = await fs.identity(at);
      // A root-owned sticky directory (the multi-user Nix store) cannot rename its root-owned children. It is safe
      // only when the daemon itself cannot write there; /tmp still fails the access check.
      const stickyDirectory = found?.kind === 'directory' && (found.mode & 0o1000) !== 0;
      if (
        found === undefined ||
        found.owner !== 0 ||
        ((found.mode & 0o022) !== 0 && !stickyDirectory) ||
        (await fs.writable(at))
      )
        return undefined;
      if (at !== real && found.kind !== 'directory') return undefined;
      if (dirname(at) === at) break;
    }
    // Resolve again after the whole walk; a changing route is never a pin.
    if ((await fs.realpath(real)) !== real) return undefined;
    const again = await fs.identity(real);
    if (
      again?.device !== file.device ||
      again.inode !== file.inode ||
      again.size !== file.size ||
      again.mtimeNs !== file.mtimeNs ||
      again.ctimeNs !== file.ctimeNs
    )
      return undefined;
    return { real, file };
  };
  try {
    const bound = await trusted(path, true);
    const stat = await trusted('/usr/bin/stat');
    if (bound === undefined || stat === undefined) return undefined;
    const file = { ...bound.file };
    const expected = [
      file.device,
      file.inode,
      file.size,
      file.mtimeNs / 1_000_000_000n,
      file.ctimeNs / 1_000_000_000n,
      file.owner,
      (file.mode & 0o7777).toString(8),
    ].join(':');
    const args = process.platform === 'darwin' ? ['-Lf', '%d:%i:%z:%m:%c:%u:%Lp'] : ['-Lc', '%d:%i:%s:%Y:%Z:%u:%a'];
    return {
      program: bound.real,
      check: { argv: [stat.real, ...args, bound.real], expected },
      verify: async () => {
        try {
          const current = await trusted(bound.real, true);
          return (
            current?.real === bound.real &&
            current.file.device === file.device &&
            current.file.inode === file.inode &&
            current.file.size === file.size &&
            current.file.mtimeNs === file.mtimeNs &&
            current.file.ctimeNs === file.ctimeNs &&
            current.file.mode === file.mode &&
            current.file.owner === file.owner
          );
        } catch {
          return false;
        }
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * `kernel.paths.checkDirectory` (today's session working-directory resolver, rule for rule): the path is trimmed; a
 * relative one is refused rather than resolved, because resolving it would silently start an agent in the DAEMON's
 * folder, which is never what the client asked for; one that does not exist, or is not a directory, is refused here
 * where the client still sees the error instead of at launch; the answer is the real path, so links and platform
 * aliases (`/tmp` and `/private/tmp`) agree with what a record stores. Read-only: it creates nothing.
 */
export async function checkDirectory(
  fs: Pick<HostFs, 'realpath' | 'identity'>,
  absolutePath: string,
): Promise<Result<CheckedDirectory, DirectoryRefusal>> {
  const requested = absolutePath.trim();
  if (!isAbsolute(requested))
    return err({
      reason: 'not_absolute',
      message: `session working directory must be absolute: ${JSON.stringify(absolutePath)}`,
    });
  const real = await fs.realpath(requested).catch(() => undefined);
  const found = real === undefined ? undefined : await fs.identity(real).catch(() => undefined);
  if (real === undefined || found?.kind !== 'directory')
    return err({ reason: 'not_a_directory', message: `session working directory is not a directory: ${requested}` });
  return ok({ realPath: real });
}

/**
 * `kernel.paths.stateHomeHolding`: the state home `absolutePath` is in, judged exactly as every owner root is (S40–S47).
 * Not a lexical stand-in: the fence is built from the disk (`fenceOf`, which THROWS when the home cannot be identified,
 * so the caller refuses), then the path is RESOLVED, link by link and `..` by `..` from where each really leads, and
 * never normalized first: a link that lives in the home and leads out is a hop through the fence, and the place the walk
 * ends at is judged by name and by identity up to `/`. The answer is the home's configured name, or `undefined` when
 * the path is outside the fence. A path that is not all there is judged at the deepest folder that is (a start in a
 * missing folder is refused later, as a folder). Read-only; a relative path is refused with a throw.
 *
 * `undefined` is the PERMISSIVE answer, so any doubt answers the home's name (the refusing answer; the callers treat
 * "held" as a refusal, so failing closed here is a return, not a throw). The walk is made of separate path-based
 * looks and the disk can change between them, so the answer is only given when three things agree: the walk's end
 * and `realpath` of the raw request are the same object, no look of the walk answers differently when asked again
 * after the judging, and neither route passes through, or ends in, the fence. A route that disagrees, a change in
 * between, or a request the disk cannot settle is "held".
 *
 * This is a DECISION-ONLY preflight: it opens nothing and holds nothing, so what it answers can be false a moment
 * later. The launch that uses it must bind or revalidate the object it checked (open it and judge the descriptor, or
 * judge again at use); that binding is not built here.
 */
export async function stateHomeHolding(
  fs: HostFs,
  home: string,
  privateFiles: { readonly files: readonly string[]; readonly recheckMs: number; readonly watch?: TruncationWatcher },
  absolutePath: string,
): Promise<string | undefined> {
  const fence = await fenceOf(fs, home, privateFiles.files, privateFiles.recheckMs, privateFiles.watch);
  const requested = absolutePath.trim();
  if (!isAbsolute(requested)) throw new TypeError(`the path must be an absolute path: ${absolutePath}`);
  // The path is NEVER normalized: a `..` is taken from where the links before it really lead (a lexical `..` would
  // erase a link hop, or swap in a folder the path never reaches). The walk follows every link, judging each one
  // that lives in the fence where it is, and ends at the real place (or the deepest real folder when the rest is
  // not there); that place is then judged by name and by identity up to `/`.
  const walk = await walkPhysically(fs, fence, requested);
  if (walk.hop) return fence.named;
  // The second route: the kernel's own resolution of the same raw request. A whole path must settle to the walk's
  // end; a path with a missing tail cannot settle, so its deepest folder is settled instead. Anything else is doubt.
  let real: string | undefined;
  try {
    real = await fs.realpath(requested);
    if (!walk.complete) return fence.named; // the walk found a missing tail, the kernel found the whole path
  } catch (error) {
    // Only a genuine ENOENT is "missing". ENOTDIR (a file stands where a folder should), ELOOP, EACCES and any errno
    // nobody named is doubt, and doubt is held, exactly as at the final recheck below.
    const gone = (error as { code?: string } | null)?.code === 'ENOENT';
    if (!gone || walk.complete) return fence.named; // not "missing", or the walk saw it all there
    real = await fs.realpath(walk.at).catch(() => undefined);
  }
  if (real === undefined || !(await sameObject(fs, walk.at, real))) return fence.named;
  if ((await fencedReal(fs, fence, real)) || (await fencedReal(fs, fence, walk.at))) return fence.named;
  // The judging took time: a link re-pointed or a folder swapped since the walk looked makes the walk's end stale.
  if (!(await walkUnchanged(fs, walk))) return fence.named;
  // A missing tail is looked for again, and only a PROVEN absence stays quiet. The request must still be "not there"
  // (ENOENT, nothing else: ELOOP, EACCES, EPERM, ENOTDIR or an errno nobody named is doubt, and a request that now
  // resolves is a tail that appeared), and the walk's own trail must still hold when asked AFTER that answer: an
  // ENOENT alone says nothing about where the route leads, e.g. an entry that became a link to a missing place in the
  // fence ends in ENOENT too. The re-look comes after the realpath so a change before its answer shows in it.
  if (!walk.complete) {
    const absent = await fs.realpath(requested).then(
      () => false,
      (error: unknown) => (error as { code?: string } | null)?.code === 'ENOENT',
    );
    if (!absent || !(await walkUnchanged(fs, walk))) return fence.named;
  }
  return undefined;
}

/**
 * What a plugin holds as `kernel.paths`. `checkDirectory` answers for ANY absolute path, with no root and no fence
 * (`~/.ssh` answers like any other), so only a manifest that declares `permissions.checkDirectory` gets it; any
 * other plugin's call is refused naming the plugin (the way `hostFacts` is).
 */
export function gatedPaths(plugin: string, declared: boolean, base: PathsPort): PathsPort {
  if (declared) return base;
  return Object.freeze({
    home: base.home,
    checkDirectory: async () => {
      throw new Error(`${plugin} did not declare permissions.checkDirectory, so it probes no absolute path.`);
    },
    bindDirectory: async () => {
      throw new Error(`${plugin} did not declare permissions.checkDirectory, so it binds no absolute path.`);
    },
    stateHomeHolding: async () => {
      throw new Error(`${plugin} did not declare permissions.checkDirectory, so it probes no absolute path.`);
    },
    // Gated on their own permission ({@link gatedWhich}), never by this one.
    which: base.which,
    bindProgram: base.bindProgram,
    locate: base.locate,
    whichFor: base.whichFor,
  });
}

/**
 * `kernel.paths.which`, `locate` and `whichFor` for one plugin: the lookups themselves (`./which.ts`) only for a
 * manifest that declares `permissions.which`; any other plugin's call is refused naming the plugin, as
 * `checkDirectory` is. They tell what is installed where, which a plugin that never asked has no business learning.
 */
export function gatedWhich(plugin: string, declared: boolean, base: PathsPort): PathsPort {
  if (declared) return base;
  const refused = async (): Promise<never> => {
    throw new Error(`${plugin} did not declare permissions.which, so it looks no command up.`);
  };
  return Object.freeze({
    home: base.home,
    checkDirectory: base.checkDirectory,
    bindDirectory: base.bindDirectory,
    stateHomeHolding: base.stateHomeHolding,
    which: refused,
    bindProgram: refused,
    locate: refused,
    whichFor: refused,
  });
}

/**
 * `kernel.paths.locate`'s variable gate: only a variable this plugin declared in `permissions.whichOverrides`, by
 * exact name ({@link mayReadOverride}); any other is refused naming the plugin BEFORE anything is read.
 */
export function gatedOverrides(plugin: string, declared: readonly string[] | undefined, base: PathsPort): PathsPort {
  return Object.freeze({
    ...base,
    locate: async (name: string, options: Parameters<PathsPort['locate']>[1]) => {
      const variable: unknown = options?.override;
      if (!mayReadOverride(declared, variable))
        throw new Error(
          `${plugin} asked for an override variable its permissions.whichOverrides does not declare, so it reads no override.`,
        );
      return await base.locate(name, { ...options, override: variable });
    },
  });
}
