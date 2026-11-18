/**
 * `slot.ts reset-v5 <N> --empty <libexec-dir>` / `restore-v5 <N> <stamp>`: put a PERSISTED slot's 5.0 side back to an EMPTY home (a
 * new identity on first boot, nothing from the fixture), keeping the old one so it can be put back.
 *
 * "Keeping" is a RENAME, never a copy and never a delete: the old `v5/home` and `v5/user` are moved into `<slot>/kept/<stamp>/` (one
 * filesystem, one slot), and that is the only thing that ever happens to them. There is no archive, no hash of the data and no `rm` of
 * anything the owner made, so there is no backup that could turn out not to be restorable: the data is simply where it was, one folder
 * over. A restore is the same rename the other way.
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
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import {
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
 * Puts `names` (the programs and the build stamp) from `libexec` into `<slot>/v5/bin`: an existing one is renamed to `<name>.prev`, the
 * new one is created exclusively (never through a link left at the name) with mode 0755, or 0644 for `stampName`. Before EACH remove,
 * rename and create the slot's tree and `bin` are looked at again, so a `bin` swapped for a link at any point is refused before the
 * next write. A destination that is a link, a folder or anything but a file is refused.
 */
export async function installPrograms(
  paths: ResetPaths,
  libexec: string,
  names: readonly string[],
  stampName: string,
): Promise<void> {
  const checked = async (): Promise<string> => {
    const tree = await assertResetTree(paths);
    await plainFolder(paths.bin, join(tree.v5Real, 'bin'));
    return join(tree.v5Real, 'bin');
  };
  for (const name of names) {
    const mode = name === stampName ? 0o644 : 0o755;
    const data = await readFile(join(libexec, name));
    const target = join(await checked(), name);
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
      await rename(target, prev);
    }
    const bin = await checked();
    const handle = await open(
      join(bin, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(data);
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  }
}

// ─── keeping: the old home is MOVED into <slot>/kept/<stamp>, and only moved ───────────────────────────────────────────

interface KeptMember {
  readonly name: string;
  readonly ino: number;
  readonly dev: number;
}

/** What `<slot>/kept/<stamp>/provenance.json` holds: this slot, its realpath, the stamp, and the identity of every moved folder. */
export interface Provenance {
  readonly format: 1;
  readonly slot: number;
  readonly slotRealpath: string;
  readonly stamp: string;
  /** UTC instant the folders were moved. */
  readonly created: string;
  readonly members: readonly KeptMember[];
}

export interface Kept {
  readonly stamp: string;
  /** `<slot realpath>/kept/<stamp>` */
  readonly dir: string;
  readonly members: readonly KeptMember[];
}

export interface KeepHooks {
  /** Test seam: runs right after a source was looked at and right before it is renamed (where a swap would have to happen). */
  readonly beforeMove?: (name: string) => Promise<void>;
}

/** Moves `moved` back to where each came from, if that place is still free; returns the names that could not go back. */
async function putBack(moved: readonly KeptMember[], tree: ResetTree, dir: string): Promise<string[]> {
  const stuck: string[] = [];
  for (const member of [...moved].reverse()) {
    const from = join(dir, member.name);
    const to = join(tree.v5Real, member.name);
    try {
      if ((await lstat(to).catch(() => undefined)) !== undefined) throw new Error(`${to} exists again`);
      await plainFolder(tree.v5Real, tree.v5Real);
      const here = await plainFolder(from, from);
      if (here.ino !== member.ino || here.dev !== member.dev) throw new Error(`${from} was replaced`);
      await rename(from, to);
    } catch {
      stuck.push(member.name);
    }
  }
  return stuck;
}

/**
 * Moves `v5/home` (and `v5/user` when it exists) into a NEW folder `<slot realpath>/kept/<stamp>` this run makes: a rename within one
 * slot. Each source is looked at right before its rename and the moved folder right after (same identity, resolves under the kept
 * folder), so a source that was swapped for another slot's folder in between is caught and moved straight back. Writes the provenance
 * record last. Returns undefined when there was nothing to move and `needHome` is off; on any failure it puts back what it moved.
 */
export async function keepAside(
  paths: ResetPaths,
  tree: ResetTree,
  now: Date,
  options: { needHome: boolean; hooks?: KeepHooks },
): Promise<Kept | undefined> {
  const stamp = resetStamp(now);
  const root = join(tree.slotReal, 'kept');
  if ((await lstat(root).catch(() => undefined)) === undefined) await mkdir(root, { mode: 0o700 });
  await plainFolder(root, root);
  const dir = join(root, stamp);
  if ((await lstat(dir).catch(() => undefined)) !== undefined)
    return refuse(`${dir} already exists; try again in a second`);
  await mkdir(dir, { mode: 0o700 });
  await plainFolder(dir, dir);
  const moved: KeptMember[] = [];
  try {
    for (const name of KEPT_MEMBERS) {
      const source = join(tree.v5Real, name);
      if ((await lstat(source).catch(() => undefined)) === undefined) {
        if (name === 'home' && options.needHome) return refuse(`${source} does not exist; nothing to put aside`);
        continue;
      }
      await plainFolder(tree.v5Real, tree.v5Real);
      const before = await plainFolder(source, source);
      await options.hooks?.beforeMove?.(name);
      const target = join(dir, name);
      await rename(source, target);
      const after = await plainFolder(target, target).catch(() => undefined);
      if (after === undefined || after.ino !== before.ino || after.dev !== before.dev) {
        // The source was swapped between the look and the move: what arrived is not this slot's folder. Put it straight back.
        await rename(target, source).catch(() => undefined);
        return refuse(`${source} was replaced while it was being moved aside`);
      }
      moved.push({ name, ino: before.ino, dev: before.dev });
    }
    if (moved.length === 0) {
      await rmdir(dir);
      return undefined;
    }
    const record: Provenance = {
      format: 1,
      slot: paths.slot,
      slotRealpath: tree.slotReal,
      stamp,
      created: now.toISOString(),
      members: moved,
    };
    await writeFile(join(dir, PROVENANCE_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const stuck = await putBack(moved, tree, dir);
    if (stuck.length === 0) {
      await rm(join(dir, PROVENANCE_FILE), { force: true }).catch(() => undefined);
      await rmdir(dir).catch(() => undefined);
      throw error;
    }
    const why = error instanceof Error ? error.message : String(error);
    throw new ResetHalfway(
      `${why}. ${stuck.join(' and ')} could not be moved back; kept in ${dir} (restore-v5 ${stamp} puts it back); nothing outside this slot was touched`,
    );
  }
  if (options.needHome && !moved.some(member => member.name === 'home')) return refuse('no home was moved aside');
  return { stamp, dir, members: moved };
}

/** `kept/<stamp>` is a kept copy THIS slot made, and its folders are still the ones that were moved: same identity, real folders, under it. */
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
  const kept: Kept = { stamp, dir, members: checked };
  await assertKept(kept);
  return kept;
}

/** The kept folders are still exactly the moved ones, and nothing else is in the kept folder. */
export async function assertKept(kept: Kept): Promise<void> {
  await plainFolder(kept.dir, kept.dir);
  const names = (await readdir(kept.dir)).sort();
  const expected = [PROVENANCE_FILE, ...kept.members.map(member => member.name)].sort();
  if (names.join('\n') !== expected.join('\n'))
    return refuse(`${kept.dir} holds ${names.join(', ')}, not the ${expected.join(', ')} that were moved`);
  for (const member of kept.members) {
    const found = await plainFolder(join(kept.dir, member.name), join(kept.dir, member.name));
    if (found.ino !== member.ino || found.dev !== member.dev)
      return refuse(`${join(kept.dir, member.name)} is not the folder that was moved there`);
  }
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

/** Writes the shim again for the NEW home's store path and updates the record's `store`. The login's own file and store are not made. */
export async function repointRealClaude(paths: RealPaths): Promise<{ login: string; store: string }> {
  const record = await readRecord(paths);
  if (record === undefined) return refuse('there is no real-claude record to re-point');
  const store = storePathOf(paths.fyHome, record.login);
  const claude = join(paths.harness, 'claude');
  const temp = `${claude}.tmp-${String(process.pid)}`;
  await writeFile(temp, shimText({ fake: join(paths.harness, FAKE_NAME), real: record.binary, store }), {
    mode: 0o755,
  });
  await chmod(temp, 0o755);
  await rename(temp, claude);
  const recordTemp = `${recordPathOf(paths)}.tmp-${String(process.pid)}`;
  await writeFile(recordTemp, recordText({ ...record, store }), { mode: 0o644 });
  await rename(recordTemp, recordPathOf(paths));
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
    await assertResetTree(paths);
    const done = await repointRealClaude(real);
    actions.say(
      `  real claude: dispatcher kept for login ${done.login}, pointed at ${done.store} (missing until the owner signs in)`,
    );
  }
  await assertResetTree(paths);
  await actions.start();
  return { kept: kept.dir, stamp: kept.stamp };
}

/**
 * Puts a kept home back (`<slot>/kept/<stamp>`, one this slot's reset or restore moved): stop, move the CURRENT home (if there is one; none
 * is fine) into `kept/<new stamp>`, move the kept folders back into `v5`, start. Renames only: nothing is read into memory, copied or removed
 * except the kept folder's own emptied provenance record and the then-empty folder.
 */
export async function restoreV5(
  paths: ResetPaths,
  actions: Pick<ResetActions, 'stop' | 'start' | 'say'>,
  stamp: string,
  now: Date,
  hooks?: KeepHooks,
): Promise<{ saved: string | undefined }> {
  const tree = await assertResetTree(paths);
  const kept = await checkKept(paths, tree, stamp);
  const nextDir = join(tree.slotReal, 'kept', resetStamp(now));
  if ((await lstat(nextDir).catch(() => undefined)) !== undefined)
    return refuse(`${nextDir} already exists; try again in a second`);

  await actions.stop();
  const live = await assertResetTree(paths);
  const saved = await keepAside(paths, live, now, { needHome: false, hooks });
  if (saved !== undefined) actions.say(`  the current 5.0 home is kept in ${saved.dir}`);
  try {
    // The kept folders are looked at again, then each is moved into `v5` (a destination that exists is never replaced) and looked at there.
    await assertKept(kept);
    const now5 = await assertResetTree(paths);
    for (const member of kept.members) {
      const target = join(now5.v5Real, member.name);
      if ((await lstat(target).catch(() => undefined)) !== undefined) return refuse(`${target} exists again`);
      await rename(join(kept.dir, member.name), target);
      const landed = await plainFolder(target, target);
      if (landed.ino !== member.ino || landed.dev !== member.dev)
        return refuse(`${target} is not the folder that was kept`);
    }
    if (!kept.members.some(member => member.name === 'user')) await mkdir(join(now5.v5Real, 'user'), { mode: 0o700 });
    // Only the kit's own record and the now empty folder: both fail rather than remove anything else.
    await rm(join(kept.dir, PROVENANCE_FILE), { force: true });
    await rmdir(kept.dir);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new ResetHalfway(
      `the kept home could not be put back (${why}). It is in ${kept.dir}${saved === undefined ? '' : `; the home it replaces is in ${saved.dir}`}; nothing outside this slot was touched`,
    );
  }
  await assertResetTree(paths);
  await actions.start();
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
  const temp = join(config, `daemon.json.tmp-${String(process.pid)}`);
  try {
    await assertResetTree(paths);
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await assertResetTree(paths);
    await plainFolder(config, config);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
