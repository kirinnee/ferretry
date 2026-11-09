/**
 * The proof that a preview run left v4 alone. Before and after, every CONFIG file the preview may read is hashed, and
 * every credential, harness-home and identity path is only `lstat`ed (size, mtime, inode, mode): its content is never
 * read. The v4 files that change on their own while v4 runs are named as volatile and are not hashed.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  'config/logins',
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

async function statLine(path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  return info === undefined
    ? 'absent'
    : `size=${info.size} mtimeMs=${info.mtimeMs} ino=${info.ino} mode=${(info.mode & 0o7777).toString(8)}`;
}

export async function snapshot(home: string, userHome?: string): Promise<Snapshot> {
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
  const host: Record<string, string> = {};
  if (userHome !== undefined) for (const path of HOST_PATHS) host[path] = await identityLine(join(userHome, path));
  return { hashes, stats, identities, live, host };
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
