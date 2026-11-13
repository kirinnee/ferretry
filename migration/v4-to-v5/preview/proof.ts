/**
 * The proof that a preview run left v4 alone. Before and after, every CONFIG file the preview may read is hashed, and
 * every credential, harness-home and identity path is only `lstat`ed (size, mtime, inode, mode): the proof never reads
 * its content. (The one login read, `prepare` taking each login's `harness` field, is in harness-map.ts; it is not part
 * of the proof.) The v4 files that change on their own while v4 runs are named as volatile and are not hashed.
 */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

/** Config files, hashed. Only paths the plan allows to be read, and never a credential. */
export const HASHED_FILES: readonly string[] = [
  'layout-version',
  'fleet/ids.json',
  'config/machine.yaml',
  'config/warden.yaml',
  'config/limits.yaml',
  'config/account-defaults.yaml',
  'config/voice.yaml',
  'config/learning.yaml',
  'config/pack.yaml',
  'config/models-guide.yaml',
  'config/routing.json',
];
/** Config folders, hashed file by file (one level deep: v4 keeps one file per name there). */
export const HASHED_FOLDERS: readonly string[] = [
  'config/runtimes',
  'config/profiles',
  'config/presets',
  'config/models',
  'config/components',
];

/**
 * Folders v4 adds entries to as it runs (a new runtime home, a new share): only the folder's identity (inode, mode) is
 * compared, never its mtime or size, so v4's own writes are not reported as damage. Never listed.
 */
export const IDENTITY_ONLY_FOLDERS: readonly string[] = [
  // Sign-ins: stat only, never listed or hashed by the proof (the preview treats the folder as credentials; prepare reads only each file's harness field, see harness-map.ts).
  'config/logins',
  'fleet/credentials',
  'fleet/homes',
  'fleet/shared',
  'state/catalogs',
];

/**
 * Credential files v4 itself rewrites while it runs (a device seen, a subscription renewed). Their stat is compared and
 * a change is reported SEPARATELY as "v4 writes these", not as damage by the preview.
 */
export const LIVE_FILES: readonly string[] = ['state/devices.json', 'state/push.json', 'state/push-vapid.json'];

/** v4's own place on the host, outside its home, relative to the user's home directory: `lstat` only. */
export const HOST_PATHS: readonly string[] = ['.config/systemd/user/fyd.service', '.local/state/ferretry'];

/** Where the host puts the caller's runtime folder and user id, for the lifecycle claim files (see {@link claimPaths}). */
export interface HostFacts {
  readonly userHome: string;
  /** `$XDG_RUNTIME_DIR`, when the caller has one. */
  readonly runtimeDir?: string | undefined;
  readonly uid?: number | undefined;
}

/** `packages/cli/src/lib/daemon/layout.ts` `claimComponent`: the length makes punctuation irrelevant. */
const claimComponent = (value: string): string => `${value.length}-${value}`;
/** `layout.ts` `claimBeside`: a hidden claim file beside an artifact. */
const claimBeside = (artifact: string, qualifier: string): string =>
  join(dirname(artifact), `.${claimComponent(basename(artifact))}.${claimComponent(qualifier)}.lifecycle.lock`);

/**
 * The lifecycle claim files v4's `fyd.service` takes when ANY process runs a lifecycle verb under the default
 * layout (`layout.ts` `lifecycleLocksFor`, manager `systemd`): the target claim in the runtime folder, the update
 * artifacts claim, the unit definition claim and the direct-daemon claim beside v4's home. Derived by name, stat only.
 * A new one appearing means something ran a lifecycle verb against v4's unit.
 */
export function claimPaths(v4Home: string, host: HostFacts): Readonly<Record<string, string>> {
  const out: Record<string, string> = {
    'claim:update-artifacts': claimBeside(
      join(host.userHome, '.local', 'state', 'ferretry', 'updates', 'fyd'),
      'updates',
    ),
    'claim:unit-definition': claimBeside(
      join(host.userHome, '.config', 'systemd', 'user', 'fyd.service'),
      'definition',
    ),
    'claim:direct-daemon': claimBeside(v4Home, 'fyd.direct'),
  };
  if (host.runtimeDir !== undefined && host.uid !== undefined)
    out['claim:unit-target'] = join(host.runtimeDir, `.${host.uid}.systemd.fyd.service.target.lifecycle.lock`);
  return out;
}

/** Credential and sign-in paths: `lstat` only. A folder is stat'ed as itself, never listed. */
export const STATTED_PATHS: readonly string[] = [
  'api-token',
  'api-warden-token',
  'state/secrets.json',
  'state/secrets.key',
  'state/daemon-identity.json',
  'state/passkeys.json',
  'state/unlocks.json',
  'state/login-secrets.json',
  'state/login-entries.json',
  'state/mcp-oauth.json',
  'state/mcp-oauth-secrets.json',
  'state/session-message-token.key',
  'state/security.json',
  'config/daemon.json',
];

/** What v4 rewrites by itself while it runs: named in the report, never hashed, never part of the verdict. */
export const VOLATILE: readonly string[] = [
  'state/sessions/** (every ferret)',
  'state/board/**',
  'state/machine-agenda/**',
  'state/index/**',
  'state/*.jsonl and state/*.log',
  'state/budget-*.json',
  'state/learning/**',
  'daemon.lock, tmux.sock, health-events.jsonl, monitor.json, logs/**',
];

export interface Snapshot {
  readonly hashes: Readonly<Record<string, string>>;
  readonly stats: Readonly<Record<string, string>>;
  /** Identity-only lines for folders, and live credential files: compared apart from `stats`. */
  readonly identities: Readonly<Record<string, string>>;
  readonly live: Readonly<Record<string, string>>;
  /** v4's service unit and state folder outside its home. */
  readonly host: Readonly<Record<string, string>>;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function identityLine(path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  return info === undefined ? 'absent' : `ino=${info.ino} mode=${(info.mode & 0o7777).toString(8)}`;
}

/** SHA-256 of a regular file, or `absent`; only ever called on a claim (lock) file, never a credential. */
async function contentHash(path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return 'absent';
  if (!info.isFile()) return 'not-a-file';
  const bytes = await readFile(path).catch(() => undefined);
  return bytes === undefined ? 'unreadable' : sha256(bytes);
}

async function statLine(path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  return info === undefined
    ? 'absent'
    : `size=${info.size} mtimeMs=${info.mtimeMs} ino=${info.ino} mode=${(info.mode & 0o7777).toString(8)}`;
}

export async function snapshot(home: string, host?: string | HostFacts): Promise<Snapshot> {
  const facts: HostFacts | undefined = typeof host === 'string' ? { userHome: host } : host;
  const hashes: Record<string, string> = {};
  const stats: Record<string, string> = {};
  const hashFile = async (relative: string) => {
    const bytes = await readFile(join(home, relative)).catch(() => undefined);
    hashes[relative] = bytes === undefined ? 'absent' : sha256(bytes);
  };
  for (const path of HASHED_FILES) await hashFile(path);
  for (const folder of HASHED_FOLDERS) {
    const entries = await readdir(join(home, folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter(item => item.isFile()).sort((a, b) => a.name.localeCompare(b.name)))
      await hashFile(`${folder}/${entry.name}`);
  }
  for (const path of STATTED_PATHS) stats[path] = await statLine(join(home, path));
  const identities: Record<string, string> = {};
  for (const path of IDENTITY_ONLY_FOLDERS) identities[path] = await identityLine(join(home, path));
  const live: Record<string, string> = {};
  for (const path of LIVE_FILES) live[path] = await statLine(join(home, path));
  const onHost: Record<string, string> = {};
  if (facts !== undefined) {
    for (const path of HOST_PATHS) onHost[path] = await identityLine(join(facts.userHome, path));
    // A claim file is a lock, not a credential: its content hash is kept too, so a claim that existed and was reused still shows.
    for (const [name, path] of Object.entries(claimPaths(home, facts)))
      onHost[name] = `${await identityLine(path)} hash=${await contentHash(path)}`;
  }
  return { hashes, stats, identities, live, host: onHost };
}

export interface Verdict {
  readonly unchanged: boolean;
  /** Paths whose hash or stat differs; names only, never a value. */
  readonly changed: readonly string[];
  /** Credential files that moved, which v4 itself rewrites while it runs: reported, not counted as damage. */
  readonly v4Wrote: readonly string[];
}

export function compare(before: Snapshot, after: Snapshot): Verdict {
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(before.hashes), ...Object.keys(after.hashes)]))
    if (before.hashes[key] !== after.hashes[key]) changed.push(key);
  for (const key of new Set([...Object.keys(before.stats), ...Object.keys(after.stats)]))
    if (before.stats[key] !== after.stats[key]) changed.push(key);
  const differs = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => a[key] !== b[key]);
  changed.push(...differs(before.identities, after.identities), ...differs(before.host, after.host));
  return { unchanged: changed.length === 0, changed, v4Wrote: differs(before.live, after.live) };
}

/**
 * Where `prepare` keeps the before-snapshot: `~/.ferretry-v5-proof/` (0700), OUTSIDE the preview home, so it is out
 * of the ferrets' working tree (not out of their reach: they run as the same user and can rewrite it as easily) and
 * outside every v4 path. One file per preview home, named
 * by a hash of the marked home's resolved path, so the proof belongs to that marker and no other. `clean` removes it.
 */
export const PROOF_FOLDER = '.ferretry-v5-proof';

/** The proof file for a preview home (a resolved path) of the user whose home directory is `userHome`. */
export const proofPathFor = (userHome: string, target: string): string =>
  join(userHome, PROOF_FOLDER, `${createHash('sha256').update(target).digest('hex').slice(0, 24)}.json`);

const Lines = z.record(z.string(), z.string());
const SnapshotSchema = z.strictObject({
  hashes: Lines,
  stats: Lines,
  identities: Lines,
  live: Lines,
  host: Lines,
});

/** Hashes and stat lines only (never a value), so the file holds nothing secret. Throws a sentence when it is damaged. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`the proof file is not readable; run prepare again after clean`);
  }
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`the proof file is not a before-snapshot; run prepare again after clean`);
  return parsed.data;
}

/**
 * Writes the before-snapshot (0600) into the 0700 proof folder. Refuses a proof folder that is a link or lies inside
 * v4's home or the preview home: the proof must sit where neither v4 nor a preview ferret's own tree reaches.
 */
export async function writeProof(userHome: string, target: string, v4Home: string, before: Snapshot): Promise<string> {
  const folder = join(userHome, PROOF_FOLDER);
  for (const guarded of [v4Home, `${v4Home}-worktrees`, target])
    if (folder === guarded || folder.startsWith(`${guarded}/`))
      throw new Error(`${folder} must not be inside ${guarded}; the proof is kept outside both`);
  const existing = await lstat(folder).catch(() => undefined);
  if (existing !== undefined && !existing.isDirectory()) throw new Error(`${folder} is not a folder; refused`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const path = proofPathFor(userHome, target);
  await writeFile(path, `${JSON.stringify(before)}\n`, { mode: 0o600 });
  return path;
}

/** Removes this preview home's proof file, and the proof folder when nothing else is in it. */
export async function removeProof(userHome: string, target: string): Promise<void> {
  await rm(proofPathFor(userHome, target), { force: true });
  await rmdir(join(userHome, PROOF_FOLDER)).catch(() => undefined);
}
