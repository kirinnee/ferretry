/**
 * `slot.ts reset-v5 <N> --empty <libexec-dir>` / `restore-v5 <N> <stamp>`: put a PERSISTED slot's 5.0 side back to an EMPTY home (a
 * new identity on first boot, nothing from the fixture), keeping the old one so it can be put back.
 *
 * "Keeping" is a RENAME, never a copy and never a delete: the old `v5/home` and `v5/user` are moved into `<slot>/kept/<stamp>/` (one
 * filesystem, one slot), and that is the only thing that ever happens to them. There is no archive, no hash of the data and no `rm` of
 * anything the owner made, so there is no backup that could turn out not to be restorable: the data is simply where it was, one folder
 * over. A restore is the same rename the other way.
 *
 * Crash safety: the plan (each folder's identity) is fsynced into `kept/<stamp>/provenance.json` BEFORE the first rename and updated after each,
 * and every file the kit writes is a temp + fsync + rename, so an interruption at any step leaves the old home or program whole and
 * `restore-v5` finishes or reverses the move. Threat model: see SWEEP.md (a same-user adversary inside the slot is out of scope; nothing outside
 * the slot realpath is ever touched, a link inside it is refused).
 *
 * Everything here takes its folders and its side effects as arguments, so a test drives it on a scratch folder with no systemd and no
 * daemon. Pure TypeScript with node: imports only: a persisted slot runs this from its own kit copy.
 *
 * What is KEPT in place: the unit files, the wrappers, cli-names.json, the 5.0 programs (or the given newer build), the fake harness,
 * the real-claude dispatcher (only with --keep-real-claude), the v4 side (never read or written here) and the port the units start the
 * daemon on (7601+2N, on the daemon's command line). The new home is a FIRST-RUN home: an EMPTY folder. The kit runs no setup and seeds
 * NO config before the first boot (a 5.0 daemon refuses a home that holds anything but has no home.json). What is MOVED ASIDE: the whole
 * 5.0 home and the 5.0 daemon's own HOME folder (`v5/user`).
 * What is NEVER written: a pairing code, a device, a login, a runtime, a profile, a project, an agenda or a board entry.
 */
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import {
  CODEX_TOOL,
  FAKE_NAME,
  isShim,
  readRecord,
  recordPathOf,
  recordText,
  shimText,
  storePathOf,
  type RealPaths,
} from './real-claude.ts';

/** `<persistent slot folder>/kept`: mode 0700, holds one folder per reset or restore, named by its UTC stamp. */
export const keptDirOf = (real: string): string => join(real, 'kept');

/** `20261118T191700Z`: a UTC stamp that sorts and holds no character a shell or a path minds. */
export const resetStamp = (when: Date): string =>
  when
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');

const STAMP_PATTERN = /^\d{8}T\d{6}Z$/u;

/** What a reset moves aside, names relative to `<slot>/v5`. `user` is the 5.0 daemon's own HOME (its fake-harness leftovers). */
export const KEPT_MEMBERS = ['home', 'user'] as const;

/** The small JSON record beside the moved folders. */
export const PROVENANCE_FILE = 'provenance.json';

export interface ResetPaths {
  /** The slot number (1..9): a kept copy's provenance record is bound to it. */
  readonly slot: number;
  /** The persistent slot folder (never the /tmp link). */
  readonly real: string;
  /** `<slot>/v5` as the daemon sees it (logical): the home, the user folder, the programs and the record live here. */
  readonly v5Dir: string;
  readonly home: string;
  readonly user: string;
  readonly harness: string;
  /** `<slot>/v5/bin`: the 5.0 programs a build install replaces. */
  readonly bin: string;
  /** The port the units start the daemon on; checked (and, only if the daemon did not record it, pinned) AFTER the first boot. */
  readonly port: number;
}

export class ResetRefusal extends Error {}
const refuse = (sentence: string): never => {
  throw new ResetRefusal(sentence);
};

/** Not a refusal: the run stopped after something moved. The message says where the old home is. */
export class ResetHalfway extends Error {}

// ─── the tree a reset or restore touches: real folders, all inside this slot ─────────────────────────────────────────

export interface ResetTree {
  /** realpath of the persistent slot folder. */
  readonly slotReal: string;
  /** `<slotReal>/v5`: where every moved path must come from and go back to. */
  readonly v5Real: string;
}

/** `path` is a real folder (lstat: no link) that resolves to exactly `expected`. Returns its identity. */
async function plainFolder(path: string, expected: string): Promise<{ ino: number; dev: number }> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory())
    return refuse(`${path} is not a plain folder (a link, a file or gone)`);
  const real = await realpath(path);
  if (real !== expected)
    return refuse(`${path} resolves to ${real}, not ${expected}: a link in its parent chain leads out of this slot`);
  return { ino: info.ino, dev: info.dev };
}

// ─── writes: a temp file this run creates, made durable, then renamed over the name ─────────────────────────────────────

/** Test seam: runs after the temp file is complete and durable, right before it is renamed over its final name. */
export type BeforePublish = (name: string, temp: string) => Promise<void>;

/**
 * Writes `data` to `<folder>/<name>`: into a temp name in the SAME folder (exclusive, never through a link, mode set), fsync, then rename
 * over the final name, so a crash or an interruption leaves the old file or none, never a half-written one. A final name that is a link,
 * a folder or anything but a plain file is refused. A temp that could not be created exclusively belongs to someone else and is left
 * alone; only one this run created is removed when anything goes wrong. The caller has just proven `folder` to be a real folder of its slot.
 */
export async function writeFileAtomic(
  folder: string,
  name: string,
  data: string | Uint8Array,
  mode: number,
  beforePublish?: BeforePublish,
): Promise<void> {
  const target = join(folder, name);
  const found = await lstat(target).catch(() => undefined);
  if (found !== undefined && (found.isSymbolicLink() || !found.isFile()))
    return refuse(`${target} is not a plain file (a link or a folder); nothing was written`);
  const temp = `${target}.tmp-${String(process.pid)}`;
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    try {
      await handle.writeFile(data);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforePublish?.(name, temp);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * The slot's own folders: `folder` (a path built from `slotReal`) must be a real folder whose realpath is exactly where it belongs under
 * the slot folder's own realpath, so a link anywhere in its chain (a swapped `v5`, `harness-bin`, ...) that leads out of the slot refuses.
 */
async function slotFolder(slotReal: string, folder: string): Promise<string> {
  const slotInfo = await lstat(slotReal).catch(() => undefined);
  if (slotInfo === undefined || slotInfo.isSymbolicLink() || !slotInfo.isDirectory())
    return refuse(`${slotReal} is not a plain folder`);
  const root = await realpath(slotReal);
  const inside = relative(slotReal, folder);
  if (inside === '..' || inside.startsWith('../')) return refuse(`${folder} is not inside ${slotReal}`);
  const expected = inside === '' ? root : join(root, inside);
  await plainFolder(folder, expected);
  return expected;
}

/** Writes `<folder>/<name>` (atomically, see writeFileAtomic) after proving `folder` is a real folder inside the slot, right before. */
export async function writeSlotFile(
  slotReal: string,
  folder: string,
  name: string,
  data: string | Uint8Array,
  mode: number,
): Promise<void> {
  await writeFileAtomic(await slotFolder(slotReal, folder), name, data, mode);
}

/** Creates `<folder>/<name>` empty when it is not there (0600) and never writes through a link; the folder is proven first. */
export async function touchSlotFile(slotReal: string, folder: string, name: string): Promise<void> {
  const real = await slotFolder(slotReal, folder);
  const handle = await open(
    join(real, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  ).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      return refuse(`${join(real, name)} is a link; nothing was written`);
    throw error;
  });
  await handle.close();
}
/**
 * The slot folder, `v5`, and (each when it exists) `v5/home`, `v5/user`, the harness folder, `v5/bin`, `home/config` and `kept` must
 * each be a real folder (lstat: not a link, not a file) whose realpath is EXACTLY where it belongs under the slot's own realpath, and
 * `config/daemon.json`, when there, a plain file. A link anywhere in the parent chain makes the realpath differ, so it is refused.
 * A check is only a snapshot: it is called before anything is stopped, again after every step that runs foreign code (the stop, the
 * build install), and immediately before each write the kit makes into one of these folders; the moves themselves look at their source
 * right before and at the moved folder right after.
 */
export async function assertResetTree(paths: ResetPaths): Promise<ResetTree> {
  const slotInfo = await lstat(paths.real).catch(() => undefined);
  if (slotInfo === undefined || !slotInfo.isDirectory() || slotInfo.isSymbolicLink())
    return refuse(`${paths.real} is not a plain folder`);
  const slotReal = await realpath(paths.real);
  const v5Real = join(slotReal, 'v5');
  const parts: Array<[string, string, boolean]> = [
    [paths.v5Dir, v5Real, true],
    [paths.home, join(v5Real, 'home'), false],
    [paths.user, join(v5Real, 'user'), false],
    [paths.harness, join(v5Real, 'harness-bin'), false],
    [paths.bin, join(v5Real, 'bin'), false],
    [join(paths.home, 'config'), join(v5Real, 'home', 'config'), false],
    [keptDirOf(paths.real), join(slotReal, 'kept'), false],
  ];
  for (const [path, expected, required] of parts) {
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) {
      if (required) return refuse(`${path} does not exist`);
      continue;
    }
    await plainFolder(path, expected);
  }
  const pin = await lstat(join(paths.home, 'config', 'daemon.json')).catch(() => undefined);
  if (pin !== undefined && (pin.isSymbolicLink() || !pin.isFile()))
    return refuse(`${join(paths.home, 'config', 'daemon.json')} is not a plain file (a link or a folder)`);
  return { slotReal, v5Real };
}

// ─── the 5.0 programs: every write is looked at first, in a folder just proven to be this slot's own ────────────────────

/**
 * Puts `names` (the programs and the build stamp) from `libexec` into `<slot>/v5/bin`. Each one is written to a temp name in `bin`
 * (exclusive, never through a link, fsync) and then renamed over its final name, so an interruption at any point leaves the old program
 * or none at that name, never a partial one. An existing program is first kept as `<name>.prev` (a hard link to the old file, so the old
 * program stays in place until the rename). Before EACH step the slot's tree and `bin` are looked at again, so a `bin` swapped for a link
 * at any point is refused before the next write. A destination that is a link, a folder or anything but a file is refused.
 */
export async function installPrograms(
  paths: ResetPaths,
  libexec: string,
  names: readonly string[],
  stampName: string,
  beforePublish?: BeforePublish,
): Promise<void> {
  const checked = async (): Promise<string> => {
    const tree = await assertResetTree(paths);
    await plainFolder(paths.bin, join(tree.v5Real, 'bin'));
    return join(tree.v5Real, 'bin');
  };
  for (const name of names) {
    const mode = name === stampName ? 0o644 : 0o755;
    const data = await readFile(join(libexec, name));
    const bin = await checked();
    const target = join(bin, name);
    const found = await lstat(target).catch(() => undefined);
    if (found !== undefined) {
      if (found.isSymbolicLink() || !found.isFile()) return refuse(`${target} is not a plain file`);
      const prev = `${target}.prev`;
      const old = await lstat(prev).catch(() => undefined);
      if (old !== undefined) {
        if (old.isDirectory()) return refuse(`${prev} is a folder`);
        await checked();
        await rm(prev, { force: true });
      }
      await checked();
      await link(target, prev);
    }
    await writeFileAtomic(await checked(), name, data, mode, beforePublish);
  }
}

// ─── keeping: the old home is MOVED into <slot>/kept/<stamp>, and only moved; the record is written FIRST ───────────────

interface KeptMember {
  readonly name: string;
  readonly ino: number;
  readonly dev: number;
}

/**
 * What `<slot>/kept/<stamp>/provenance.json` holds: this slot, its realpath, the stamp, and the identity of every folder the move is
 * about. It is written (and fsynced) BEFORE the first rename, so a run that is interrupted at any step leaves a record that says what was
 * meant to move: `members` is the plan (identity read right before), `moved` the names inside this folder as of the last update
 * (advisory: the identities in `members` decide where each folder really is), `status` is 'moving' until every rename is done.
 */
export interface Provenance {
  readonly format: 1;
  readonly slot: number;
  readonly slotRealpath: string;
  readonly stamp: string;
  /** UTC instant the move began. */
  readonly created: string;
  /** 'restored': every folder is back in `v5`; only the restart (and then the removal of this record) is pending. */
  readonly status: 'moving' | 'kept' | 'restored';
  readonly members: readonly KeptMember[];
  readonly moved: readonly string[];
}

/** Where a planned folder is right now: inside the kept folder, or still (or again) at `v5/<name>`. */
export type Place = 'kept' | 'v5';

export interface Kept {
  readonly stamp: string;
  /** `<slot realpath>/kept/<stamp>` */
  readonly dir: string;
  readonly members: readonly KeptMember[];
  /** Where each planned folder was found by identity. */
  readonly places: ReadonlyMap<string, Place>;
  /** The record as read (or, right after a move, as written). */
  readonly record: Provenance;
}

export interface KeepHooks {
  /** Test seam: runs right after a source was looked at and right before it is renamed (where a swap would have to happen). */
  readonly beforeMove?: (name: string) => Promise<void>;
  /** Test seam: runs right after a rename and its record update (where an interruption would leave a split state). */
  readonly afterMove?: (name: string) => Promise<void>;
}

const RECORD_TEMP = `${PROVENANCE_FILE}.tmp`;

/** fsync of a folder: what makes a rename or a mkdir inside it durable. */
async function syncFolder(folder: string): Promise<void> {
  const handle = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * A run killed while updating the record leaves `provenance.json.tmp`; its exclusive create would then fail for good. Removes EXACTLY that
 * name when it is a regular file in `dir` (the caller has proven `dir` to be a real kept folder of this slot); a link or a folder under
 * that name is refused, never followed or removed.
 */
async function clearStaleRecordTemp(dir: string): Promise<void> {
  const temp = join(dir, RECORD_TEMP);
  const found = await lstat(temp).catch(() => undefined);
  if (found === undefined) return;
  if (found.isSymbolicLink() || !found.isFile()) return refuse(`${temp} is not a plain file; refusing to touch it`);
  await rm(temp);
}

/** Writes the record: a temp file in the kept folder (exclusive), fsync, rename over, fsync of the folder. */
async function writeRecord(dir: string, record: Provenance): Promise<void> {
  const temp = join(dir, RECORD_TEMP);
  await clearStaleRecordTemp(dir);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, join(dir, PROVENANCE_FILE));
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncFolder(dir);
}

/**
 * Moves `names` of `v5` (`home`, and `user` when it exists) into a NEW folder `<slot realpath>/kept/<stamp>` this run makes: a rename
 * within one slot. The plan (each source's identity) is written to `provenance.json` and fsynced BEFORE the first rename and updated after
 * each, so an interruption at any step leaves a record that restore-v5 reconciles. Each source is looked at again right before its rename
 * and the moved folder right after (same identity, resolves under the kept folder), so a source that was swapped for another slot's
 * folder in between is caught and moved straight back. Returns undefined when there was nothing to move and `needHome` is off. A
 * failure after something moved is NOT undone here (an interruption could not be either): it says where everything is and that
 * restore-v5 <stamp> puts it back.
 */
export async function keepAside(
  paths: ResetPaths,
  tree: ResetTree,
  now: Date,
  options: { needHome: boolean; names?: readonly string[]; hooks?: KeepHooks },
): Promise<Kept | undefined> {
  const stamp = resetStamp(now);
  const root = join(tree.slotReal, 'kept');
  const dir = join(root, stamp);
  if ((await lstat(root).catch(() => undefined)) !== undefined) {
    await plainFolder(root, root);
    if ((await lstat(dir).catch(() => undefined)) !== undefined)
      return refuse(`${dir} already exists; try again in a second`);
  }
  const plan: KeptMember[] = [];
  for (const name of options.names ?? KEPT_MEMBERS) {
    const source = join(tree.v5Real, name);
    if ((await lstat(source).catch(() => undefined)) === undefined) {
      if (name === 'home' && options.needHome) return refuse(`${source} does not exist; nothing to put aside`);
      continue;
    }
    const found = await plainFolder(source, source);
    plan.push({ name, ino: found.ino, dev: found.dev });
  }
  if (plan.length === 0) return undefined;
  if (options.needHome && !plan.some(member => member.name === 'home')) return refuse('no home was moved aside');
  if ((await lstat(root).catch(() => undefined)) === undefined) {
    await mkdir(root, { mode: 0o700 });
    await syncFolder(tree.slotReal);
  }
  await plainFolder(root, root);
  await mkdir(dir, { mode: 0o700 });
  await syncFolder(root);
  await plainFolder(dir, dir);
  const record = (status: 'moving' | 'kept', moved: readonly string[]): Provenance => ({
    format: 1,
    slot: paths.slot,
    slotRealpath: tree.slotReal,
    stamp,
    created: now.toISOString(),
    status,
    members: plan,
    moved,
  });
  await writeRecord(dir, record('moving', []));
  const moved: string[] = [];
  const where = `restore-v5 ${stamp} puts everything back (it needs no current home)`;
  try {
    for (const member of plan) {
      const source = join(tree.v5Real, member.name);
      await plainFolder(tree.v5Real, tree.v5Real);
      const before = await plainFolder(source, source);
      if (before.ino !== member.ino || before.dev !== member.dev)
        return refuse(`${source} was replaced after it was looked at`);
      await options.hooks?.beforeMove?.(member.name);
      const target = join(dir, member.name);
      await rename(source, target);
      const after = await plainFolder(target, target).catch(() => undefined);
      if (after === undefined || after.ino !== member.ino || after.dev !== member.dev) {
        // The source was swapped between the look and the move: what arrived is not this slot's folder. Put it straight back.
        await rename(target, source).catch(() => undefined);
        return refuse(`${source} was replaced while it was being moved aside`);
      }
      moved.push(member.name);
      await writeRecord(dir, record('moving', moved));
      await options.hooks?.afterMove?.(member.name);
    }
    await writeRecord(dir, record('kept', moved));
  } catch (error) {
    if (moved.length === 0) {
      // Nothing moved: the record and the folder are the kit's own and empty of anything the owner made; take them away again.
      await rm(join(dir, PROVENANCE_FILE), { force: true }).catch(() => undefined);
      await rmdir(dir).catch(() => undefined);
      throw error;
    }
    const why = error instanceof Error ? error.message : String(error);
    throw new ResetHalfway(
      `${why}. ${moved.length === 0 ? 'Nothing was moved' : `${moved.join(' and ')} ${moved.length === 1 ? 'is' : 'are'} in ${dir}`}; ${where}; nothing outside this slot was touched`,
    );
  }
  return {
    stamp,
    dir,
    members: plan,
    places: new Map(plan.map(member => [member.name, 'kept' as const])),
    record: record('kept', moved),
  };
}

/**
 * `kept/<stamp>` is a kept copy THIS slot made (a complete record, or one an interrupted reset or restore left): every planned folder is
 * found by identity, inside the kept folder or back at `v5/<name>`, and nothing else is in the kept folder.
 */
export async function checkKept(paths: ResetPaths, tree: ResetTree, stamp: string): Promise<Kept> {
  if (!STAMP_PATTERN.test(stamp)) return refuse(`"${stamp}" is not a stamp (like 20261118T191700Z)`);
  const dir = join(tree.slotReal, 'kept', stamp);
  await plainFolder(join(tree.slotReal, 'kept'), join(tree.slotReal, 'kept')).catch(() =>
    refuse(`${join(tree.slotReal, 'kept')} does not exist: this slot has nothing kept`),
  );
  await plainFolder(dir, dir).catch(() => refuse(`${dir} is not a kept copy (missing, a link or a file)`));
  const path = join(dir, PROVENANCE_FILE);
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined)
    return refuse(`${dir} has no ${PROVENANCE_FILE}: only a copy this slot's reset or restore moved can be put back`);
  if (info.isSymbolicLink() || !info.isFile()) return refuse(`${path} is not a plain file`);
  if ((info.mode & 0o077) !== 0)
    return refuse(`${path} is readable by others (mode ${(info.mode & 0o777).toString(8)})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return refuse(`${path} is not valid JSON`);
  }
  const record = parsed as Partial<Record<keyof Provenance, unknown>> | null;
  const members = record?.members;
  if (
    typeof record !== 'object' ||
    record === null ||
    record.format !== 1 ||
    typeof record.slot !== 'number' ||
    typeof record.slotRealpath !== 'string' ||
    typeof record.stamp !== 'string' ||
    typeof record.created !== 'string' ||
    (record.status !== 'moving' && record.status !== 'kept' && record.status !== 'restored') ||
    !Array.isArray(record.moved) ||
    !Array.isArray(members)
  )
    return refuse(`${path} is damaged`);
  if (record.slot !== paths.slot || record.slotRealpath !== tree.slotReal)
    return refuse(
      `${dir} was made by another slot (record: slot ${String(record.slot)} at ${record.slotRealpath}); it does not match this one`,
    );
  if (record.stamp !== stamp) return refuse(`${path} names stamp ${record.stamp}, not ${stamp}`);
  const checked: KeptMember[] = [];
  for (const entry of members as unknown[]) {
    const item = entry as Partial<KeptMember> | null;
    if (
      typeof item !== 'object' ||
      item === null ||
      !(KEPT_MEMBERS as readonly unknown[]).includes(item.name) ||
      typeof item.ino !== 'number' ||
      typeof item.dev !== 'number' ||
      checked.some(known => known.name === item.name)
    )
      return refuse(`${path} lists a folder this kit does not keep`);
    checked.push({ name: item.name as string, ino: item.ino, dev: item.dev });
  }
  if (!checked.some(member => member.name === 'home')) return refuse(`${path} lists no home`);
  const kept = { stamp, dir, members: checked, record: record as unknown as Provenance };
  return { ...kept, places: await placesOf(kept, tree) };
}

/**
 * Finds each planned folder BY IDENTITY: inside the kept folder, or at `v5/<name>` (not moved yet, or already put back). Anything else
 * (gone, another folder at its place, a link) is refused, and so is anything in the kept folder that is not the record, its temp or a
 * planned folder.
 */
async function placesOf(kept: Omit<Kept, 'places'>, tree: ResetTree): Promise<ReadonlyMap<string, Place>> {
  const places = new Map<string, Place>();
  await plainFolder(kept.dir, kept.dir);
  const names = (await readdir(kept.dir)).filter(name => name !== RECORD_TEMP).sort();
  const known = new Set<string>([PROVENANCE_FILE, ...kept.members.map(member => member.name)]);
  const stray = names.filter(name => !known.has(name));
  if (stray.length > 0) return refuse(`${kept.dir} holds ${stray.join(', ')}, which was never moved there`);
  for (const member of kept.members) {
    const inside = join(kept.dir, member.name);
    const outside = join(tree.v5Real, member.name);
    const here = (await lstat(inside).catch(() => undefined)) !== undefined;
    const path = here ? inside : outside;
    if (!here && (await lstat(outside).catch(() => undefined)) === undefined)
      return refuse(`${member.name} is neither in ${kept.dir} nor at ${outside}`);
    const found = await plainFolder(path, path);
    if (found.ino !== member.ino || found.dev !== member.dev)
      return refuse(`${path} is not the folder that was moved (another folder is there)`);
    places.set(member.name, here ? 'kept' : 'v5');
  }
  return places;
}

/**
 * The new home: an EMPTY folder (0700) and nothing in it, and an empty `user` for the daemon's own HOME. A 5.0 daemon refuses a home that
 * holds anything but has no home.json, so the kit can seed NOTHING before the first boot; the daemon makes home.json, its identity and the rest itself.
 */
export async function writeFreshHome(paths: ResetPaths): Promise<void> {
  // The tree is looked at right now, and each folder is made with a plain mkdir (no `recursive`: it FAILS if something is already there,
  // so a folder that was put in the way is never adopted) under the slot's own v5 realpath, then looked at again.
  const tree = await assertResetTree(paths);
  for (const name of KEPT_MEMBERS) {
    const path = join(tree.v5Real, name);
    await mkdir(path, { mode: 0o700 });
    await plainFolder(path, path);
  }
  await assertResetTree(paths);
}

/** What is in a home that has just been made empty: used by tests and by the post-start proof. Names of files under `config/` and `state/`. */
export async function homeFiles(home: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(relative(home, path));
    }
  };
  await walk(home);
  return out.sort();
}

/**
 * Real codex has no `--keep`: a reset removes the login and its sign-in with the old home, so a slot with real codex on refuses until
 * `real-codex <n> off` (which never deletes the login). Names and paths only; nothing inside a store is opened.
 */
export async function realCodexPreflight(paths: RealPaths): Promise<void> {
  const record = await readRecord(paths, CODEX_TOOL);
  if (record !== undefined)
    return refuse(
      `real codex is on for login ${record.login}; a reset removes that login and its sign-in with the old home. Run "real-codex <n> off" first (it never deletes that login)`,
    );
  const codex = await readFile(join(paths.harness, 'codex'), 'utf8').catch(() => '');
  if (isShim(codex, CODEX_TOOL))
    return refuse(
      `${join(paths.harness, 'codex')} is a real-codex shim but there is no ${CODEX_TOOL.recordFile}; refusing to guess`,
    );
}

// ─── real claude: re-point, never sign in ──────────────────────────────────────────────────────────────────────────

/**
 * With real claude ON, a reset keeps the dispatcher for the SAME login, pointed at the store path of the NEW home (the same
 * string, because the new home lives where the old one did; the shim is written again from the record so the claim is checked, not
 * assumed). The store folder is gone with the old home and the login file is not in the new one: the owner adds the login again
 * and presses Sign in (5.0 creates the store then). The real binary and the fake must still be there.
 */
export async function realClaudePreflight(
  paths: RealPaths,
  keep: boolean,
): Promise<{ login: string; binary: string } | undefined> {
  const record = await readRecord(paths);
  if (record === undefined) {
    const claude = await readFile(join(paths.harness, 'claude'), 'utf8').catch(() => '');
    if (isShim(claude))
      return refuse(
        `${join(paths.harness, 'claude')} is a real-claude shim but there is no ${basename(recordPathOf(paths))}; refusing to guess`,
      );
    return undefined;
  }
  if (!keep)
    return refuse(
      `real claude is on for login ${record.login}; a reset removes that login and its sign-in with the old home. Pass --keep-real-claude to keep the dispatcher for the same login name (you add the login and sign in again), or run "real-claude <n> off" first`,
    );
  const info = await stat(record.binary).catch(() => undefined);
  if (info === undefined || !info.isFile() || (info.mode & 0o111) === 0)
    return refuse(
      `the real claude ${record.binary} is not an executable file any more; run "real-claude <n> off" first`,
    );
  if ((await lstat(join(paths.harness, FAKE_NAME)).catch(() => undefined)) === undefined)
    return refuse(`${join(paths.harness, FAKE_NAME)} is missing, so the shim cannot be written again`);
  return { login: record.login, binary: record.binary };
}

/**
 * Writes the shim again for the NEW home's store path and updates the record's `store`. The login's own file and store are not made.
 * `v5Real` is the slot's `v5` realpath from a tree check just made: the harness folder and `v5` are proven real folders of this slot right
 * before each write, and each file goes through a temp this run creates and a rename (a link at the final name is refused, never followed).
 */
export async function repointRealClaude(paths: RealPaths, v5Real: string): Promise<{ login: string; store: string }> {
  const record = await readRecord(paths);
  if (record === undefined) return refuse('there is no real-claude record to re-point');
  const store = storePathOf(paths.fyHome, record.login);
  await plainFolder(paths.harness, join(v5Real, 'harness-bin'));
  await writeFileAtomic(
    join(v5Real, 'harness-bin'),
    'claude',
    shimText({ fake: join(paths.harness, FAKE_NAME), real: record.binary, store }),
    0o755,
  );
  await plainFolder(paths.v5Dir, v5Real);
  await writeFileAtomic(v5Real, basename(recordPathOf(paths)), recordText({ ...record, store }), 0o644);
  return { login: record.login, store };
}

// ─── the whole reset, and the way back ─────────────────────────────────────────────────────────────────────────────

export interface ResetActions {
  /** Stops ONLY this slot's 5.0 daemon and its tmux server, and the headless Chrome of the 5.0 browser profile. v4 is not named here. */
  readonly stop: () => Promise<void>;
  /** Puts the given programs in place (a no-op when the slot already runs them). Called after the stop, before anything is moved. */
  readonly installBuild: () => Promise<void>;
  /** Starts the tmux server and the daemon and waits until it serves. */
  readonly start: () => Promise<void>;
  readonly say: (line: string) => void;
}

export interface ResetOptions {
  readonly keepRealClaude: boolean;
  readonly now: Date;
  readonly hooks?: KeepHooks;
}

/** The home the new daemon will find; the old one is MOVED to `<slot>/kept/<stamp>`, never copied, packed or removed. */
export async function resetV5(
  paths: ResetPaths,
  real: RealPaths,
  actions: ResetActions,
  options: ResetOptions,
): Promise<{ kept: string; stamp: string }> {
  // Everything that can refuse, BEFORE anything is stopped.
  await assertResetTree(paths);
  const homeInfo = await lstat(paths.home).catch(() => undefined);
  if (homeInfo === undefined || !homeInfo.isDirectory() || homeInfo.isSymbolicLink())
    return refuse(`${paths.home} is missing or not a plain folder; there is no 5.0 home to reset`);
  const keep = await realClaudePreflight(real, options.keepRealClaude);
  await realCodexPreflight(real);

  await actions.stop();
  await assertResetTree(paths);
  await actions.installBuild();
  // The install ran foreign code: look again, then move the old home INSIDE the slot. Nothing below names a path under `v5` that was
  // resolved before an earlier step ran.
  const tree = await assertResetTree(paths);
  const kept = await keepAside(paths, tree, options.now, { needHome: true, hooks: options.hooks });
  if (kept === undefined) return refuse('no home was moved aside');
  actions.say(`  the old 5.0 home is kept in ${kept.dir} (moved, not copied: nothing was deleted)`);
  try {
    await writeFreshHome(paths);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new ResetHalfway(
      `the new empty home could not be made (${why}). The old 5.0 home is untouched in ${kept.dir}; restore-v5 ${kept.stamp} puts it back (it needs no current home); nothing outside this slot was touched`,
    );
  }
  if (keep !== undefined) {
    const checked = await assertResetTree(paths);
    const done = await repointRealClaude(real, checked.v5Real);
    actions.say(
      `  real claude: dispatcher kept for login ${done.login}, pointed at ${done.store} (missing until the owner signs in)`,
    );
  }
  await assertResetTree(paths);
  await actions.start();
  return { kept: kept.dir, stamp: kept.stamp };
}

/**
 * Puts a kept home back (`<slot>/kept/<stamp>`, one this slot's reset or restore moved, complete or left half way by an interruption):
 * stop, move the CURRENT home (if there is one; none is fine) into `kept/<new stamp>`, move the kept folders back into `v5`, start.
 * Renames only: nothing is read into memory, copied or removed except the kept folder's own emptied provenance record and the then-empty
 * folder. Each folder is found by the identity the record holds, so a retry after an interruption (some folders already back, some not)
 * reconciles the split state: a folder already at `v5/<name>` is left, one still in the kept folder is moved back. The record is kept (as
 * `status: restored`) until the start has succeeded, so a start that was interrupted is retried with the same stamp: it just starts again.
 */
export async function restoreV5(
  paths: ResetPaths,
  actions: Pick<ResetActions, 'stop' | 'start' | 'say'>,
  stamp: string,
  now: Date,
  hooks?: KeepHooks,
): Promise<{ saved: string | undefined }> {
  const tree = await assertResetTree(paths);
  const planned = await checkKept(paths, tree, stamp);
  // A temp a killed update left is cleared (that exact name, a plain file, in the proven kept folder) before anything is stopped or moved.
  await clearStaleRecordTemp(planned.dir);
  // Folders already back where they belong are the kept ones; whatever else sits at `v5/<name>` is the current home. A completed
  // restore (status 'restored') has nothing to set aside: its `v5` IS the restored home and only the restart is left.
  const aside =
    planned.record.status === 'restored' ? [] : KEPT_MEMBERS.filter(name => planned.places.get(name) !== 'v5');
  const nextDir = join(tree.slotReal, 'kept', resetStamp(now));
  if ((await lstat(nextDir).catch(() => undefined)) !== undefined)
    return refuse(`${nextDir} already exists; try again in a second`);

  await actions.stop();
  const live = await assertResetTree(paths);
  const saved = await keepAside(paths, live, now, { needHome: false, names: aside, hooks });
  if (saved !== undefined) actions.say(`  the current 5.0 home is kept in ${saved.dir}`);
  let kept = planned;
  try {
    // The kept folders are looked at again, then each is moved into `v5` (a destination that exists is never replaced) and looked at there.
    kept = await checkKept(paths, live, stamp);
    const now5 = await assertResetTree(paths);
    let inside = kept.members.filter(member => kept.places.get(member.name) === 'kept').map(member => member.name);
    for (const member of kept.members) {
      if (kept.places.get(member.name) !== 'kept') continue;
      const target = join(now5.v5Real, member.name);
      if ((await lstat(target).catch(() => undefined)) !== undefined) return refuse(`${target} exists again`);
      await plainFolder(now5.v5Real, now5.v5Real);
      await hooks?.beforeMove?.(member.name);
      await rename(join(kept.dir, member.name), target);
      const landed = await plainFolder(target, target);
      if (landed.ino !== member.ino || landed.dev !== member.dev)
        return refuse(`${target} is not the folder that was kept`);
      inside = inside.filter(name => name !== member.name);
      await writeRecord(kept.dir, { ...kept.record, status: 'moving', moved: inside });
      await hooks?.afterMove?.(member.name);
    }
    if (
      !kept.members.some(member => member.name === 'user') &&
      (await lstat(join(now5.v5Real, 'user')).catch(() => undefined)) === undefined
    )
      await mkdir(join(now5.v5Real, 'user'), { mode: 0o700 });
    // Everything is back: the record stays (as a completion record) until the start has succeeded.
    await writeRecord(kept.dir, { ...kept.record, status: 'restored', moved: [] });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new ResetHalfway(
      `the kept home could not be put back (${why}). What is not back yet is in ${kept.dir}${saved === undefined ? '' : `; the home it replaces is in ${saved.dir}`}; run restore-v5 ${stamp} again to finish it; nothing outside this slot was touched`,
    );
  }
  await assertResetTree(paths);
  await actions.start();
  // Started: only the kit's own record and the now empty folder go; both fail rather than remove anything else.
  await rm(join(kept.dir, PROVENANCE_FILE), { force: true });
  await rm(join(kept.dir, RECORD_TEMP), { force: true });
  await rmdir(kept.dir);
  return { saved: saved?.dir };
}

/**
 * The port pin, written ONLY when the first-booted daemon recorded none: `config/daemon.json` gets a bind carrier on 127.0.0.1 and the
 * slot's port (merged into what the daemon wrote; other carriers and keys are kept). It is the only file the kit ever writes into a new home.
 * The home, its `config` folder and `daemon.json` are looked at (real folders under this slot, a plain file or none) right before the
 * temp file is made and again right before it is renamed over `daemon.json`; a linked destination is refused.
 */
export async function writeBindPin(paths: ResetPaths, port: number): Promise<void> {
  const tree = await assertResetTree(paths);
  const home = join(tree.v5Real, 'home');
  await plainFolder(paths.home, home);
  const config = join(home, 'config');
  if ((await lstat(config).catch(() => undefined)) === undefined) await mkdir(config, { mode: 0o700 });
  await plainFolder(config, config);
  const file = join(config, 'daemon.json');
  const found = await lstat(file).catch(() => undefined);
  if (found !== undefined && (found.isSymbolicLink() || !found.isFile()))
    return refuse(`${file} is not a plain file (a link or a folder)`);
  let read: unknown = {};
  if (found !== undefined) {
    try {
      read = JSON.parse((await readFile(file, 'utf8')) || '{}');
    } catch {
      return refuse(`${file} is not valid JSON; the pin was not written`);
    }
  }
  const document: Record<string, unknown> =
    typeof read === 'object' && read !== null && !Array.isArray(read) ? (read as Record<string, unknown>) : {};
  const others = (Array.isArray(document.carriers) ? (document.carriers as unknown[]) : []).filter(
    entry => !(typeof entry === 'object' && entry !== null && (entry as { kind?: unknown }).kind === 'bind'),
  );
  document.carriers = [{ kind: 'bind', host: '127.0.0.1', port }, ...others];
  // Written like every kit file: a temp this run creates exclusively (a temp that was already there is someone else's and stays), fsync,
  // then renamed over `daemon.json` after the tree and the config folder are looked at again.
  await assertResetTree(paths);
  await plainFolder(config, config);
  await writeFileAtomic(config, 'daemon.json', `${JSON.stringify(document, null, 2)}\n`, 0o600, async () => {
    await assertResetTree(paths);
    await plainFolder(config, config);
  });
}
