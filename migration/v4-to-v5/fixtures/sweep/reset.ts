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
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve } from 'node:path';
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
  /** The slot number (1..9): a tar's provenance record is bound to it. */
  readonly slot: number;
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

// ─── the tree a reset or restore touches: real folders, all inside this slot ─────────────────────────────────────────

export interface ResetTree {
  /** realpath of the persistent slot folder. */
  readonly slotReal: string;
  /** `<slotReal>/v5`: where every archived path must end up. */
  readonly v5Real: string;
}

/**
 * The slot folder, `v5`, `v5/home`, `v5/user` (when it exists) and the backup folder (when it exists) must each be a real folder (lstat: not a
 * link, not a file) whose realpath is EXACTLY where it belongs under the slot's own realpath. A link anywhere in the parent chain (a `v5`
 * that points at another slot, a slot folder reached through a link) makes the realpath differ, so it is refused. Called before anything is
 * stopped, moved or removed, and again after the stop.
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
    [backupDirOf(paths.real), join(slotReal, 'reset-backups'), false],
  ];
  for (const [path, expected, required] of parts) {
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) {
      if (required) return refuse(`${path} does not exist`);
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return refuse(`${path} is not a plain folder (a link or a file)`);
    const real = await realpath(path);
    if (real !== expected)
      return refuse(`${path} resolves to ${real}, not ${expected}: a link in its parent chain leads out of this slot`);
  }
  return { slotReal, v5Real };
}

// ─── what a tar may hold ─────────────────────────────────────────────────────────────────────────────────────────

export type TarKind = 'file' | 'dir' | 'symlink' | 'hardlink';
export interface TarMember {
  readonly name: string;
  readonly kind: TarKind;
  /** The link target (symlink: as written; hardlink: a name inside the archive). Empty for the rest. */
  readonly target: string;
}

const BLOCK = 512;
const EXTENSION_LIMIT = 1 << 20;

const textField = (block: Buffer, from: number, to: number): string => {
  const raw = block.subarray(from, to);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul < 0 ? raw.length : nul).toString('utf8');
};

const numberField = (block: Buffer, from: number, to: number): number | undefined => {
  if (((block[from] ?? 0) & 0x80) !== 0) {
    let value = (block[from] ?? 0) & 0x7f;
    for (let at = from + 1; at < to; at += 1) value = value * 256 + (block[at] ?? 0);
    return value;
  }
  const text = textField(block, from, to).trim();
  if (text === '') return 0;
  return /^[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : undefined;
};

function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = space < 0 ? Number.NaN : Number.parseInt(data.subarray(at, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= space - at + 1 || at + length > data.length)
      return refuse('the archive has a damaged extended header');
    const body = data.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = body.indexOf('=');
    if (equals > 0) out.set(body.slice(0, equals), body.slice(equals + 1));
    at += length;
  }
  return out;
}

/**
 * Reads a tar's headers (never its data) and returns every member with its kind and link target, or refuses. Pure node: `tar -t` shows no
 * link targets and no types in a form worth parsing, so the headers are read here: ustar, GNU long names (L/K) and PAX (x) are understood;
 * a global PAX header, a sparse, a device, a fifo or any other type is refused outright.
 */
export async function inspectTar(file: string): Promise<TarMember[]> {
  const handle = await open(file, 'r');
  try {
    const total = (await handle.stat()).size;
    const members: TarMember[] = [];
    const header = Buffer.alloc(BLOCK);
    let at = 0;
    let longName: string | undefined;
    let longLink: string | undefined;
    let pax = new Map<string, string>();
    const readData = async (size: number): Promise<Buffer> => {
      if (size > EXTENSION_LIMIT) return refuse('the archive has an oversized extended header');
      const buffer = Buffer.alloc(size);
      const got = size === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, size, at + BLOCK);
      if (got.bytesRead !== size) return refuse('the archive ends in the middle of a header');
      return buffer;
    };
    for (;;) {
      if (at === total) break;
      const read = await handle.read(header, 0, BLOCK, at);
      if (read.bytesRead !== BLOCK) return refuse('the archive ends in the middle of a header');
      if (header.every(byte => byte === 0)) break;
      let sum = 0;
      for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
      if (numberField(header, 148, 156) !== sum) return refuse('the archive has a header with a bad checksum');
      const flag = header[156] === 0 ? '0' : String.fromCharCode(header[156] ?? 0);
      const rawSize = numberField(header, 124, 136);
      if (rawSize === undefined) return refuse('the archive has a header with an unreadable size');
      const size = pax.has('size') ? Number.parseInt(pax.get('size') ?? '', 10) : rawSize;
      if (!Number.isFinite(size) || size < 0) return refuse('the archive has a header with an unreadable size');
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (flag === 'x' || flag === 'L' || flag === 'K') {
        const data = await readData(rawSize);
        if (flag === 'x') pax = new Map([...pax, ...paxRecords(data)]);
        else {
          const nul = data.indexOf(0);
          const text = data.subarray(0, nul < 0 ? data.length : nul).toString('utf8');
          if (flag === 'L') longName = text;
          else longLink = text;
        }
        at += BLOCK + Math.ceil(rawSize / BLOCK) * BLOCK;
        continue;
      }
      const posixMagic = textField(header, 257, 263) === 'ustar';
      const prefix = posixMagic ? textField(header, 345, 500) : '';
      const base = textField(header, 0, 100);
      const name = longName ?? pax.get('path') ?? (prefix === '' ? base : `${prefix}/${base}`);
      const target = longLink ?? pax.get('linkpath') ?? textField(header, 157, 257);
      let kind: TarKind;
      if (flag === '0') kind = 'file';
      else if (flag === '5') kind = 'dir';
      else if (flag === '2') kind = 'symlink';
      else if (flag === '1') kind = 'hardlink';
      else if (flag === '3' || flag === '4' || flag === '6')
        return refuse(`the archive holds "${name}", a device or a fifo`);
      else return refuse(`the archive holds "${name}" of a kind this kit does not restore (type "${flag}")`);
      members.push({ name, kind, target: kind === 'symlink' || kind === 'hardlink' ? target : '' });
      longName = undefined;
      longLink = undefined;
      pax = new Map();
      at += BLOCK + (kind === 'file' ? padded : 0);
      if (at > total) return refuse('the archive ends in the middle of a file');
    }
    return members;
  } finally {
    await handle.close();
  }
}

/**
 * Where a symlink lands: undefined when that is somewhere a restore may put it. `name` is the link's own path (relative to the folder that
 * holds home/ and user/); a relative target is resolved from the link's folder and must stay under home/ or user/; an absolute target must be
 * under THIS slot's own v5/home or v5/user (the real path), nowhere else.
 */
export function symlinkProblem(name: string, target: string, v5Real: string): string | undefined {
  const shown = `the archive holds a symlink "${name}" -> "${target}"`;
  if (target === '' || target.includes('\0')) return `${shown}, which has no target`;
  if (target.startsWith('/')) {
    const clean = posix.normalize(target);
    const inside = TAR_MEMBERS.some(
      member => clean === join(v5Real, member) || clean.startsWith(`${join(v5Real, member)}/`),
    );
    return inside ? undefined : `${shown}, which points outside this slot's home`;
  }
  const landed = posix.normalize(posix.join(posix.dirname(name), target));
  const first = landed.split('/')[0] ?? '';
  if (landed.startsWith('..') || !(TAR_MEMBERS as readonly string[]).includes(first))
    return `${shown}, which points outside home/ and user/`;
  return undefined;
}

/** Every member's name, kind and link target: the first problem, or undefined. A member may not sit under a symlink the archive itself made. */
export function tarMembersProblem(members: readonly TarMember[], v5Real: string): string | undefined {
  const links = new Set<string>();
  for (const member of members) {
    const name = member.name.replace(/\/+$/u, '');
    const problem = tarEntryProblem(name);
    if (problem !== undefined) return problem;
    const parts = name.split('/');
    for (let depth = 1; depth < parts.length; depth += 1)
      if (links.has(parts.slice(0, depth).join('/')))
        return `the archive holds "${name}" under a symlink it made itself`;
    if (member.kind === 'symlink') {
      const bad = symlinkProblem(name, member.target, v5Real);
      if (bad !== undefined) return bad;
      links.add(name);
    } else if (member.kind === 'hardlink') {
      const target = member.target.replace(/\/+$/u, '');
      const bad = tarEntryProblem(target);
      if (bad !== undefined)
        return `the archive holds a hard link "${name}" -> "${member.target}", which points outside home/ and user/`;
      const targetParts = target.split('/');
      for (let depth = 1; depth <= targetParts.length; depth += 1)
        if (links.has(targetParts.slice(0, depth).join('/')))
          return `the archive holds a hard link "${name}" through a symlink`;
    }
  }
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

// ─── provenance: a tar this slot made, unchanged ─────────────────────────────────────────────────────────────────────

export const provenancePathOf = (tarFile: string): string => `${tarFile}.provenance.json`;

export interface Provenance {
  readonly format: 1;
  readonly slot: number;
  readonly slotRealpath: string;
  readonly tar: string;
  /** UTC instant the tar was made. */
  readonly created: string;
  readonly sha256: string;
}

const sha256Of = async (file: string): Promise<string> =>
  await new Promise<string>((done, fail) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', fail);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => done(hash.digest('hex')));
  });

/** Writes the record beside `tarFile` (0600, new file): this slot, its realpath, the instant, and the tar's sha256. */
export async function writeProvenance(paths: ResetPaths, tarFile: string, now: Date): Promise<void> {
  const record: Provenance = {
    format: 1,
    slot: paths.slot,
    slotRealpath: await realpath(paths.real),
    tar: basename(tarFile),
    created: now.toISOString(),
    sha256: await sha256Of(tarFile),
  };
  await writeFile(provenancePathOf(tarFile), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(provenancePathOf(tarFile), 0o600);
}

/** The record beside `file` must be a plain 0600 file for THIS slot (number and realpath), this tar's name, and its current hash. Returns the hash. */
export async function checkProvenance(paths: ResetPaths, file: string): Promise<string> {
  const path = provenancePathOf(file);
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined)
    return refuse(
      `${file} has no provenance record (${basename(path)}): only a tar this slot's reset or restore made can be put back`,
    );
  if (info.isSymbolicLink() || !info.isFile()) return refuse(`the provenance record ${path} is not a plain file`);
  if ((info.mode & 0o077) !== 0)
    return refuse(`the provenance record ${path} is readable by others (mode ${(info.mode & 0o777).toString(8)})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return refuse(`the provenance record ${path} is not valid JSON`);
  }
  const record = parsed as Partial<Record<keyof Provenance, unknown>> | null;
  if (
    typeof record !== 'object' ||
    record === null ||
    record.format !== 1 ||
    typeof record.slot !== 'number' ||
    typeof record.slotRealpath !== 'string' ||
    typeof record.tar !== 'string' ||
    typeof record.sha256 !== 'string' ||
    typeof record.created !== 'string'
  )
    return refuse(`the provenance record ${path} is damaged`);
  if (record.slot !== paths.slot || record.slotRealpath !== (await realpath(paths.real)))
    return refuse(
      `${file} was made by another slot (record: slot ${String(record.slot)} at ${record.slotRealpath}); it does not match this one`,
    );
  if (record.tar !== basename(file)) return refuse(`the provenance record names ${record.tar}, not ${basename(file)}`);
  const hash = await sha256Of(file);
  if (hash !== record.sha256)
    return refuse(`${file} does not match the hash its provenance record holds: it was changed after it was made`);
  return hash;
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
  try {
    await writeProvenance(paths, file, now);
  } catch (error) {
    await rm(file, { force: true });
    await rm(provenancePathOf(file), { force: true });
    return refuse(
      `could not write the provenance record (${error instanceof Error ? error.message : String(error)}); nothing was removed`,
    );
  }
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
  await assertResetTree(paths);
  const homeInfo = await lstat(paths.home).catch(() => undefined);
  if (homeInfo === undefined || !homeInfo.isDirectory() || homeInfo.isSymbolicLink())
    return refuse(`${paths.home} is missing or not a plain folder; there is no 5.0 home to reset`);
  const keep = await realClaudePreflight(real, options.keepRealClaude);

  await actions.stop();
  await assertResetTree(paths);
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

/** After the extraction into the temp folder: home (and user) are real folders, and nothing in the tree is a device, a fifo or a bad link. */
async function verifyExtracted(stage: string, tree: ResetTree): Promise<void> {
  const stageReal = await realpath(stage);
  for (const name of TAR_MEMBERS) {
    const path = join(stage, name);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) {
      if (name === 'home') return refuse('the archive extracted no home/');
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return refuse(`the extracted ${name} is not a plain folder`);
    if ((await realpath(path)) !== join(stageReal, name))
      return refuse(`the extracted ${name} resolves outside its folder`);
  }
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isSymbolicLink()) {
        const bad = symlinkProblem(relative(stage, path), await readlink(path), tree.v5Real);
        if (bad !== undefined) return refuse(bad);
      } else if (!entry.isFile())
        return refuse(`the extracted tree holds "${relative(stage, path)}", which is not a plain file`);
    }
  };
  await walk(stage);
}

/** Puts the old home back from one of the slot's own tars; the CURRENT home is tarred first, so a restore never loses one. */
export async function restoreV5(
  paths: ResetPaths,
  tar: TarPorts,
  actions: Pick<ResetActions, 'stop' | 'start' | 'say'>,
  tarArg: string,
  now: Date,
): Promise<{ saved: string }> {
  const tree = await assertResetTree(paths);
  const file = await checkBackupFile(paths.real, tarArg);
  await checkProvenance(paths, file);
  const listed = await tar.list(file);
  if (listed.code !== 0 || listed.entries.length === 0)
    return refuse(`${file} cannot be read as a tar (${listed.err.trim().slice(0, 200)})`);
  for (const entry of listed.entries) {
    const problem = tarEntryProblem(entry);
    if (problem !== undefined) return refuse(problem);
  }
  const members = await inspectTar(file);
  const bad = tarMembersProblem(members, tree.v5Real);
  if (bad !== undefined) return refuse(bad);
  if (!members.some(member => member.name.replace(/\/+$/u, '') === 'home' || member.name.startsWith('home/')))
    return refuse(`${file} holds no home/`);
  // Extract into a fresh folder under the slot and look at what came out BEFORE anything is stopped or removed.
  const stage = await mkdtemp(join(tree.slotReal, '.restore-'));
  try {
    await chmod(stage, 0o700);
    // The tar is read again right before it is opened: the hash must still be the record's.
    await checkProvenance(paths, file);
    const out = await tar.extract(stage, file);
    if (out.code !== 0)
      return refuse(`extracting ${file} failed (${out.err.trim().slice(0, 200)}); nothing was changed`);
    await verifyExtracted(stage, tree);
    await actions.stop();
    await assertResetTree(paths);
    const saved = await makeBackup(tar, paths, 'restore', now);
    actions.say(`  the current 5.0 home is kept as ${saved}`);
    await rm(paths.home, { recursive: true, force: true });
    await rm(paths.user, { recursive: true, force: true });
    await rename(join(stage, 'home'), paths.home);
    if ((await lstat(join(stage, 'user')).catch(() => undefined)) !== undefined)
      await rename(join(stage, 'user'), paths.user);
    await mkdir(paths.user, { recursive: true, mode: 0o700 });
    await actions.start();
    return { saved };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * The port pin, written ONLY when the first-booted daemon recorded none: `config/daemon.json` gets a bind carrier on 127.0.0.1 and the
 * slot's port (merged into what the daemon wrote; other carriers and keys are kept). It is the only file the kit ever writes into a new home.
 */
export async function writeBindPin(home: string, port: number): Promise<void> {
  const file = join(home, 'config', 'daemon.json');
  const text = (await readFile(file, 'utf8').catch(() => '{}')) || '{}';
  const read = JSON.parse(text) as unknown;
  const document: Record<string, unknown> =
    typeof read === 'object' && read !== null && !Array.isArray(read) ? (read as Record<string, unknown>) : {};
  const others = (Array.isArray(document.carriers) ? (document.carriers as unknown[]) : []).filter(
    entry => !(typeof entry === 'object' && entry !== null && (entry as { kind?: unknown }).kind === 'bind'),
  );
  document.carriers = [{ kind: 'bind', host: '127.0.0.1', port }, ...others];
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}
