/**
 * The provisioner's disk: every file call it makes, as an ASYNCHRONOUS call on the kernel's `fleet` root.
 *
 * Today's provisioner reached the disk by raw path and raw descriptor (`openSync`, `fchmodSync`, hard `link`). A plugin
 * has none of those: it holds a {@link RootHandle}, whose every call fences its path, opens each parent folder without
 * following a link and refuses a link on the way. This file is the one place an ABSOLUTE path (the plan's spelling) is
 * turned into a path inside that root, so the rules below hold for every caller and cannot be forgotten at one:
 *
 *  - WRITES land in the fleet folder only. Anything else is refused in a sentence (`refusing to write outside configured
 *    fleet roots`), lexically first (no `..`, no second root) and then by the kernel (a link on the way is `link_escape`).
 *  - READS of a component SOURCE (a copy, a link target, a settings layer) are served only from the folders Runtimes may
 *    declare: the fleet's `assets/` tree and the harness homes. The rest of the fleet folder holds runtimes' own homes
 *    and the credentials Ferretry keeps (`credentials/`), so it is never a source. A path no mount names is refused,
 *    never opened.
 *  - A sign-in file (`.credentials.json`, `auth.json`) is never a source, as any component of the path or anywhere in a
 *    copied folder: a credential is stored once and LINKED, never copied (`link` is the one way a sign-in is reached,
 *    and it reads nothing).
 *
 * No text read here is ever put in a sentence, and no call returns a secret value (use, never read).
 */
import { isAbsolute, join, relative, sep } from 'node:path';
import type { FencedPath, RootEntry, RootHandle, RootLstat, RootStat, RootsPort } from '@ferretry/kernel/contract';
import { harnessMounts, type HostMounts } from './root-host-files.ts';

/** The names a sign-in lives in; never read, never copied, never listed as a source. */
const SIGN_IN_FILES: ReadonlySet<string> = new Set(['.credentials.json', 'auth.json']);

/** The most entries one source folder may hold when it is walked for a sign-in file. */
const MAX_SOURCE_ENTRIES = 10_000;

/** The largest single file a copy reads whole. */
const MAX_COPIED_FILE_BYTES = 8 * 1024 * 1024;

/** An entry that is already there where a new one was to be made (the root's `exclusive` publish says so). */
export class AlreadyExistsError extends Error {
  readonly code = 'EEXIST';
  constructor(path: string) {
    super(`${path} already exists`);
    this.name = 'AlreadyExistsError';
  }
}

/**
 * The host cannot move an entry within the fleet folder safely (no descriptor reach, as on macOS), so the apply stops
 * before it changes anything it cannot put back. [own] BEFORE-GREEN(runtimes): a macOS reach is being designed.
 */
export class NoDescriptorReachError extends Error {
  constructor(entry: string, options: ErrorOptions) {
    super(
      `this machine cannot move ${entry} aside safely (the fleet folder cannot be reached through a descriptor on this host), so the change was stopped (what it had already written is rolled back, and anything that could not be is listed)`,
      options,
    );
    this.name = 'NoDescriptorReachError';
  }
}

/** `path` below `base` (`''` for the base itself), or `undefined` when it is not at or under it. */
function below(base: string, path: string): string | undefined {
  if (!isAbsolute(base) || !isAbsolute(path)) return undefined;
  const inside = relative(base, path);
  if (inside === '') return '';
  return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? undefined : inside;
}

/** The components of an absolute path below its base that name a sign-in file. */
const namesSignIn = (inside: string): boolean => inside.split(sep).some(part => SIGN_IN_FILES.has(part));

export interface FleetDiskOptions {
  /** The `fleet` root: the ONLY place anything is written. */
  readonly fleet: RootHandle;
  /** The fleet folder's absolute path, as the root names it. */
  readonly directory: string;
  /** What serves a SOURCE path (a copy, a link target, a settings layer): see {@link sourceMounts}. */
  readonly sources: HostMounts;
}

export class FleetDisk {
  readonly fleet: RootHandle;
  readonly directory: string;
  readonly #sources: HostMounts;

  constructor(options: FleetDiskOptions) {
    this.fleet = options.fleet;
    this.directory = options.directory;
    this.#sources = options.sources;
  }

  // ─── the destination: the fleet root ───────────────────────────────────────────────────────────────────────────

  /** Whether `path` is the fleet folder or below it, by name. */
  contains(path: string): boolean {
    return below(this.directory, path) !== undefined;
  }

  /** The fenced path of an absolute `path` in the fleet folder; throws the sentence of a refusal. */
  fenced(path: string): FencedPath {
    const inside = below(this.directory, path);
    if (inside === undefined) throw new Error(`refusing to write outside configured fleet roots: ${path}`);
    const resolved = this.fleet.resolve(inside === '' ? '.' : inside);
    if (!resolved.ok)
      throw new Error(`refusing to use ${path}: the fleet folder could not open it (${resolved.error})`);
    return resolved.value;
  }

  /**
   * What is AT the name, the leaf not followed; `undefined` when nothing is, or when a folder above it is not there
   * (the root answers `outside` for that; the name was checked to be inside the fleet folder first). A link on the way
   * is NOT absence: it stays a refusal.
   */
  async lstat(path: string): Promise<RootLstat | undefined> {
    return await absentWhenFolderMissing(async () => await this.fleet.lstat(this.fenced(path)));
  }

  /** The names in a folder, each with its own kind (a link is listed, never entered). */
  async entries(path: string): Promise<readonly RootEntry[]> {
    return await this.fleet.entries(this.fenced(path));
  }

  /** The bytes of the regular file at `path`; throws when it is not one, is a link, or is larger than `limit`. */
  async readBytes(path: string, limit: number): Promise<Uint8Array> {
    return await this.fleet.readBytes(this.fenced(path), limit);
  }

  async readText(path: string, limit: number): Promise<string> {
    return await this.fleet.readText(this.fenced(path), limit);
  }

  /** The device and inode the name reaches (the leaf not followed), or `undefined`. */
  async identity(path: string): Promise<string | undefined> {
    const found = await absentWhenFolderMissing(async () => await this.fleet.fileIdentity(this.fenced(path)));
    return found === undefined ? undefined : `${found.device}:${found.inode}`;
  }

  /**
   * A NEW file, created exclusively: the root links it into place, so a name that is taken (a file, a link) is
   * {@link AlreadyExistsError} and left exactly as it was.
   */
  async create(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    const outcome = await this.fleet.publish(this.fenced(path), bytes, { mode, exclusive: true });
    if (outcome.outcome === 'exists') throw new AlreadyExistsError(path);
  }

  /** `mkdir -p` in the fleet folder; each folder it makes gets `mode`. */
  async makeFolder(path: string, mode: number): Promise<void> {
    await this.fleet.makeDirectory(this.fenced(path), { mode });
  }

  /** Moves the entry AS IS (a link stays a link) onto a name nothing holds; a taken name is refused, never replaced. */
  async rename(from: string, to: string): Promise<void> {
    try {
      await this.fleet.rename(this.fenced(from), this.fenced(to));
    } catch (error) {
      // A host that cannot reach a folder through its descriptor (macOS) refuses every move: nothing can be set aside as
      // evidence, so the apply stops and is rolled back. There is no copy fallback, and nothing is moved by path.
      if (error instanceof Error && error.message === 'root refused: no_descriptor_reach') {
        throw new NoDescriptorReachError(from, { cause: error });
      }
      throw error;
    }
  }

  /** Removes the entry, a tree whole, never following a link. */
  async remove(path: string): Promise<void> {
    await this.fleet.remove(this.fenced(path));
  }

  /** Narrows (or keeps) the permission bits of an existing file or folder, through a descriptor opened without following a link. */
  async setMode(path: string, mode: number): Promise<void> {
    await this.fleet.setMode(this.fenced(path), mode);
  }

  // ─── the sources: the folders Runtimes may declare ──────────────────────────────────────────────────────────────

  /** Where a source path is served from, or the sentence of its refusal. */
  #source(path: string): { readonly root: RootHandle; readonly at: FencedPath; readonly inside: string } {
    const mounted = this.#sources(path);
    if (mounted === undefined || mounted.kind !== 'root') throw refusedSource(path);
    // A sign-in is never a source, by any component of its path (the leaf, or a folder named like one).
    if (namesSignIn(mounted.inside)) throw refusedSignIn(path);
    const resolved = mounted.root.resolve(mounted.inside === '' ? '.' : mounted.inside);
    if (!resolved.ok) throw new Error(`${path} could not be opened as a source (${resolved.error})`);
    return { root: mounted.root, at: resolved.value, inside: mounted.inside };
  }

  /** Whether a source path is served from a folder Runtimes may declare (the name only; nothing is opened). */
  isSource(path: string): boolean {
    const mounted = this.#sources(path);
    return mounted?.kind === 'root' && !namesSignIn(mounted.inside);
  }

  /** Throws the refusal when `path` is not served as a component source (nothing is opened or looked at). */
  assertServed(path: string): void {
    const mounted = this.#sources(path);
    if (mounted === undefined || mounted.kind !== 'root') throw refusedSource(path);
    if (namesSignIn(mounted.inside)) throw refusedSignIn(path);
  }

  /** What is at a source path (a link not followed), or `undefined`. Throws the refusal sentence for an unserved path. */
  async sourceKind(path: string): Promise<RootLstat | undefined> {
    const { root, at, inside } = this.#source(path);
    return inside === '' ? asLstat(await root.stat(at)) : await root.lstat(at);
  }

  /**
   * The text of a component document, or `undefined` when it is absent, not a regular file, over `maxBytes` or
   * unreadable. A path no mount serves, or one naming a sign-in, throws: it is refused, not "not there".
   */
  async readSource(path: string, maxBytes: number): Promise<string | undefined> {
    const { root, at } = this.#source(path);
    try {
      const found = await root.lstat(at);
      if (found?.kind !== 'file' || found.size > maxBytes) return undefined;
      return await root.readText(at, maxBytes);
    } catch {
      return undefined;
    }
  }

  /** The text of a settings layer: the same reach as {@link readSource}, but absent or unreadable is an error. */
  async readSourceText(path: string): Promise<string> {
    const { root, at } = this.#source(path);
    return await root.readText(at, MAX_COPIED_FILE_BYTES);
  }

  /**
   * Whether the source is a folder, and proof it may be a source at all: served, not a sign-in, present. A folder is
   * walked for a sign-in file anywhere inside it (bounded), because the copy takes every file in it.
   */
  async assertSource(path: string): Promise<'file' | 'directory'> {
    const { root, at, inside } = this.#source(path);
    const found = await lookAtSource(async () => await root.stat(at));
    if (found === undefined) throw new Error(`the source ${path} does not exist`);
    if (found.kind === 'directory') await this.#assertNoSignIn(root, inside, path);
    return found.kind;
  }

  /** Walks the folder (bounded) and refuses at the first entry named like a sign-in; `inside` is relative to the root. */
  async #assertNoSignIn(root: RootHandle, inside: string, shown: string): Promise<void> {
    let seen = 0;
    const walk = async (folder: string): Promise<void> => {
      const at = root.resolve(folder === '' ? '.' : folder);
      if (!at.ok) throw new Error(`${shown} could not be walked (${at.error})`);
      for (const entry of await root.entries(at.value)) {
        seen += 1;
        if (seen > MAX_SOURCE_ENTRIES) throw new Error(`refusing to copy ${shown}: it holds too many entries`);
        if (SIGN_IN_FILES.has(entry.name)) throw refusedSignIn(join(shown, entry.name));
        if (entry.kind === 'directory') await walk(join(folder, entry.name));
      }
    };
    await walk(inside);
  }

  /**
   * Copies the source (a file or a folder) to the NEW name `destination` in the fleet folder. A folder is copied by
   * the root (a link inside is skipped, a file with a second hard link is skipped, modes kept); a file is read whole
   * through a checked descriptor and created exclusively.
   */
  async copyInto(source: string, destination: string, mode: number): Promise<'file' | 'directory'> {
    const kind = await this.assertSource(source);
    const { root, at } = this.#source(source);
    if (kind === 'directory') {
      await this.fleet.copyTree(root, at, this.fenced(destination));
      return kind;
    }
    const bytes = await root.readBytes(at, MAX_COPIED_FILE_BYTES);
    await this.create(destination, bytes, mode);
    return kind;
  }

  /**
   * Proof, before anything is written, that `source` may be a link's target: served from a folder Runtimes may
   * declare and, unless `dangling`, there. A sign-in file IS a valid target (a runtime's credential link leads to it),
   * though never a copy source; nothing is read.
   */
  async checkLinkTarget(source: string, dangling: boolean): Promise<void> {
    const mounted = this.#sources(source);
    if (mounted === undefined || mounted.kind !== 'root') throw refusedSource(source);
    if (dangling) return;
    const at = mounted.root.resolve(mounted.inside === '' ? '.' : mounted.inside);
    if (!at.ok || (await lookAtSource(async () => await mounted.root.lstat(at.value))) === undefined) {
      throw new Error(`the link target ${source} does not exist`);
    }
  }

  /**
   * A link at `at` (in the fleet folder) leading to `source`, which must be served from a folder Runtimes may declare.
   * Reads nothing: a credential link is the one way a sign-in is reached. `dangling` allows a target that is not
   * there yet (an empty sign-in slot, which the harness writes THROUGH the link).
   */
  async linkTo(at: string, source: string, dangling: boolean): Promise<void> {
    const mounted = this.#sources(source);
    if (mounted === undefined || mounted.kind !== 'root') throw refusedSource(source);
    const target = mounted.root.resolve(mounted.inside === '' ? '.' : mounted.inside);
    if (!target.ok) throw new Error(`${source} could not be opened as a link target (${target.error})`);
    await this.fleet.linkTo(this.fenced(at), {
      root: mounted.root,
      path: target.value,
      ...(dangling ? { dangling: true as const } : {}),
    });
  }
}

/** A name inside the fleet folder whose parent is not there is simply absent; every other refusal stays one. */
async function absentWhenFolderMissing<T>(
  look: () => Promise<T | undefined>,
  refusals: readonly string[] = ['outside'],
): Promise<T | undefined> {
  try {
    return await look();
  } catch (error) {
    if (error instanceof Error && refusals.some(refusal => error.message === `root refused: ${refusal}`))
      return undefined;
    throw error;
  }
}

/**
 * A SOURCE that cannot be looked at because a folder above it is missing, or changed while it was opened, is absent:
 * a source is only ever read, so "not there" is the fail-closed answer and the sentence says it does not exist.
 */
const lookAtSource = async <T>(look: () => Promise<T | undefined>): Promise<T | undefined> =>
  await absentWhenFolderMissing(look, ['outside', 'changed']);

const asLstat = (stat: RootStat | undefined): RootLstat | undefined => stat;

const refusedSource = (path: string): Error =>
  new Error(
    `${path} is outside the folders Runtimes may read a component from on this machine (the fleet's assets and the harness homes), so it was not opened`,
  );

const refusedSignIn = (path: string): Error =>
  new Error(`${path} is a sign-in file; a credential is stored once and linked, never read or copied`);

/**
 * The mounts that serve a SOURCE: the fleet's `assets/` tree (and only it: the rest of the fleet folder holds runtimes'
 * own homes and the credentials Ferretry keeps), and each harness home as a `harness-home` root scoped to that home.
 */
export function sourceMounts(
  roots: Pick<RootsPort, 'root' | 'harnessFile'>,
  fleet: RootHandle,
  fleetDirectory: string,
  harnessHomes: readonly string[],
): HostMounts {
  const assets = join(fleetDirectory, 'assets');
  const homes = harnessMounts(roots, harnessHomes);
  return path => {
    const inside = below(assets, path);
    if (inside !== undefined)
      return { kind: 'root', root: fleet, inside: inside === '' ? 'assets' : join('assets', inside) };
    return homes(path);
  };
}
