/**
 * `slot.ts reset-v5 <N> --empty <libexec-dir>` / `restore-v5 <N> <tar>`: put a PERSISTED slot's 5.0 side back to an EMPTY home (a
 * new identity on first boot, nothing from the fixture), keeping the old one as a tar so it can be put back.
 *
 * Everything here takes its folders and its side effects as arguments, so a test drives it on a scratch folder with no systemd, no
 * daemon and no real tar of a real home. Pure TypeScript with node: imports only: a persisted slot runs this from its own kit copy.
 *
 * What is KEPT: the unit files, the wrappers, cli-names.json, the 5.0 programs (or the given newer build), the fake harness, the real-claude
 * dispatcher (only with --keep-real-claude), the v4 side (never read or written here) and the port the units start the daemon on (7601+2N,
 * on the daemon's command line). The new home is a FIRST-RUN home: an EMPTY folder. The kit runs no setup and seeds NO config before the
 * first boot (a 5.0 daemon refuses a home that holds anything but has no home.json, so nothing could be seeded anyway): no gate, no daemon
 * name, no relay or WebRTC key, no limits file. What is REMOVED (into the tar first): the whole 5.0 home and the 5.0 daemon's own HOME
 * folder (`v5/user`).
 * What is NEVER written: a pairing code, a device, a login, a runtime, a profile, a project, an agenda or a board entry.
 */
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
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

/** `<persistent slot folder>/reset-backups`: mode 0700, holds only the tars below. */
export const backupDirOf = (real: string): string => join(real, 'reset-backups');

/** `20261118T191700Z`: a UTC stamp that sorts and holds no character a shell or a path minds. */
export const resetStamp = (when: Date): string =>
  when
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');

/** The tar of the old 5.0 side: `v5-<stamp>.tar`. `kind` says which verb made it. */
export const backupName = (stamp: string, kind: 'reset' | 'restore'): string => `v5-${kind}-${stamp}.tar`;

/** What the tar holds: names relative to `<slot>/v5`. `user` is the 5.0 daemon's own HOME (its fake-harness leftovers). */
export const TAR_MEMBERS = ['home', 'user'] as const;

export interface ResetPaths {
  /** The persistent slot folder (never the /tmp link). */
  readonly real: string;
  /** `<slot>/v5` as the daemon sees it (logical): the home, the user folder, the programs and the record live here. */
  readonly v5Dir: string;
  readonly home: string;
  readonly user: string;
  readonly harness: string;
  /** The port the units start the daemon on; checked (and, only if the daemon did not record it, pinned) AFTER the first boot. */
  readonly port: number;
}

export class ResetRefusal extends Error {}
const refuse = (sentence: string): never => {
  throw new ResetRefusal(sentence);
};

/** The names a tar listing may hold: only `home` and `user` (and what is under them), nothing absolute, nothing with `..`. */
export function tarEntryProblem(entry: string): string | undefined {
  if (entry === '' || entry.startsWith('/') || entry.split('/').includes('..'))
    return `the archive holds an unsafe path "${entry}"`;
  const first = entry.split('/')[0] ?? '';
  if (!(TAR_MEMBERS as readonly string[]).includes(first))
    return `the archive holds "${entry}", which is not under home/ or user/`;
  return undefined;
}

export interface TarPorts {
  /** `tar -C <dir> -cf <file> <members…>` */
  readonly create: (dir: string, file: string, members: readonly string[]) => Promise<{ code: number; err: string }>;
  /** `tar -tf <file>`: the entry names. */
  readonly list: (file: string) => Promise<{ code: number; entries: string[]; err: string }>;
  /** `tar -C <dir> -xpf <file>` */
  readonly extract: (dir: string, file: string) => Promise<{ code: number; err: string }>;
}

/** A private folder (0700) of the backups, created if need be. A link or a file in its place is refused. */
export async function ensureBackupDir(real: string): Promise<string> {
  const dir = backupDirOf(real);
  const found = await lstat(dir).catch(() => undefined);
  if (found !== undefined && (!found.isDirectory() || found.isSymbolicLink()))
    return refuse(`${dir} is not a plain folder`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

/**
 * Tars `members` of `v5Dir` into a NEW file in the backup folder (mode 0600 from the first byte: the file is made empty with that
 * mode, then tar writes into it), reads the tar back, and chmods it again. Returns the tar's path. A tar that cannot be written
 * or read back is removed and nothing else is touched.
 */
export async function makeBackup(
  tar: TarPorts,
  paths: ResetPaths,
  kind: 'reset' | 'restore',
  now: Date,
): Promise<string> {
  const dir = await ensureBackupDir(paths.real);
  const file = join(dir, backupName(resetStamp(now), kind));
  if ((await lstat(file).catch(() => undefined)) !== undefined)
    return refuse(`${file} already exists; try again in a second`);
  const members: string[] = [];
  for (const name of TAR_MEMBERS)
    if ((await lstat(join(paths.v5Dir, name)).catch(() => undefined)) !== undefined) members.push(name);
  if (!members.includes('home')) return refuse(`${paths.home} does not exist; nothing to put aside`);
  await writeFile(file, '', { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
  const made = await tar.create(paths.v5Dir, file, members);
  const back = made.code === 0 ? await tar.list(file) : { code: made.code, entries: [] as string[], err: made.err };
  if (made.code !== 0 || back.code !== 0 || back.entries.length === 0) {
    await rm(file, { force: true });
    return refuse(
      `could not archive the old home (${(made.err || back.err).trim().slice(0, 200)}); nothing was removed`,
    );
  }
  await chmod(file, 0o600);
  return file;
}

/**
 * The new home: an EMPTY folder (0700) and nothing in it. A 5.0 daemon refuses a home that holds anything but has no home.json, so the
 * kit can seed NOTHING before the first boot (not a port pin, not limits); the daemon makes home.json, its identity and the rest itself.
 */
export async function writeFreshHome(paths: ResetPaths): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  await mkdir(paths.user, { recursive: true, mode: 0o700 });
  await chmod(paths.user, 0o700);
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
  /** Puts the given programs in place (a no-op when the slot already runs them). Called after the stop, before anything is removed. */
  readonly installBuild: () => Promise<void>;
  /** Starts the tmux server and the daemon and waits until it serves. */
  readonly start: () => Promise<void>;
  readonly say: (line: string) => void;
}

export interface ResetOptions {
  readonly keepRealClaude: boolean;
  readonly now: Date;
}

/** The home the new daemon will find; `reset` removes the old one only after its tar is written and read back. Returns the tar's path. */
export async function resetV5(
  paths: ResetPaths,
  real: RealPaths,
  tar: TarPorts,
  actions: ResetActions,
  options: ResetOptions,
): Promise<{ tar: string }> {
  // Everything that can refuse, BEFORE anything is stopped.
  const homeInfo = await lstat(paths.home).catch(() => undefined);
  if (homeInfo === undefined || !homeInfo.isDirectory() || homeInfo.isSymbolicLink())
    return refuse(`${paths.home} is missing or not a plain folder; there is no 5.0 home to reset`);
  const keep = await realClaudePreflight(real, options.keepRealClaude);

  await actions.stop();
  await actions.installBuild();
  const file = await makeBackup(tar, paths, 'reset', options.now);
  actions.say(`  the old 5.0 home is kept as ${file} (mode 0600, in a 0700 folder)`);
  await rm(paths.home, { recursive: true, force: true });
  await rm(paths.user, { recursive: true, force: true });
  await writeFreshHome(paths);
  if (keep !== undefined) {
    const done = await repointRealClaude(real);
    actions.say(
      `  real claude: dispatcher kept for login ${done.login}, pointed at ${done.store} (missing until the owner signs in)`,
    );
  }
  await actions.start();
  return { tar: file };
}

/** The tar named on the command line must be one of this slot's own backups: a regular 0600 file directly in its backup folder. */
export async function checkBackupFile(real: string, tarArg: string): Promise<string> {
  const dir = await realpath(backupDirOf(real)).catch(() => undefined);
  if (dir === undefined) return refuse(`${backupDirOf(real)} does not exist: this slot has no backups`);
  const file = resolve(tarArg);
  const info = await lstat(file).catch(() => undefined);
  if (info === undefined) return refuse(`${file} does not exist`);
  if (info.isSymbolicLink() || !info.isFile()) return refuse(`${file} is not a plain file`);
  if (dirname(await realpath(file)) !== dir) return refuse(`${file} is not directly inside ${dir}`);
  if ((info.mode & 0o077) !== 0)
    return refuse(
      `${file} is readable by others (mode ${(info.mode & 0o777).toString(8)}); refusing to restore from it`,
    );
  return file;
}

/** Puts the old home back from one of the slot's own tars; the CURRENT home is tarred first, so a restore never loses one. */
export async function restoreV5(
  paths: ResetPaths,
  tar: TarPorts,
  actions: Pick<ResetActions, 'stop' | 'start' | 'say'>,
  tarArg: string,
  now: Date,
): Promise<{ saved: string }> {
  const file = await checkBackupFile(paths.real, tarArg);
  const listed = await tar.list(file);
  if (listed.code !== 0 || listed.entries.length === 0)
    return refuse(`${file} cannot be read as a tar (${listed.err.trim().slice(0, 200)})`);
  for (const entry of listed.entries) {
    const problem = tarEntryProblem(entry);
    if (problem !== undefined) return refuse(problem);
  }
  if (!listed.entries.some(entry => entry === 'home' || entry === 'home/' || entry.startsWith('home/')))
    return refuse(`${file} holds no home/`);
  await actions.stop();
  const saved = await makeBackup(tar, paths, 'restore', now);
  actions.say(`  the current 5.0 home is kept as ${saved}`);
  await rm(paths.home, { recursive: true, force: true });
  await rm(paths.user, { recursive: true, force: true });
  const out = await tar.extract(paths.v5Dir, file);
  if (out.code !== 0)
    return refuse(`extracting ${file} failed (${out.err.trim().slice(0, 200)}); the home you had is in ${saved}`);
  await mkdir(paths.user, { recursive: true, mode: 0o700 });
  await actions.start();
  return { saved };
}
