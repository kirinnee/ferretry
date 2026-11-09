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
];

/** Credential and sign-in paths: `lstat` only. A folder is stat'ed as itself, never listed. */
export const STATTED_PATHS: readonly string[] = [
  'api-token',
  'api-warden-token',
  'fleet/credentials',
  'fleet/homes',
  'fleet/shared',
  'state/secrets.json',
  'state/secrets.key',
  'state/daemon-identity.json',
  'state/devices.json',
  'state/passkeys.json',
  'state/unlocks.json',
  'state/push.json',
  'state/push-vapid.json',
  'state/login-secrets.json',
  'state/login-entries.json',
  'state/mcp-oauth.json',
  'state/mcp-oauth-secrets.json',
  'state/session-message-token.key',
  'state/catalogs',
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
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function statLine(path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  return info === undefined
    ? 'absent'
    : `size=${info.size} mtimeMs=${info.mtimeMs} ino=${info.ino} mode=${(info.mode & 0o7777).toString(8)}`;
}

export async function snapshot(home: string): Promise<Snapshot> {
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
  return { hashes, stats };
}

export interface Verdict {
  readonly unchanged: boolean;
  /** Paths whose hash or stat differs; names only, never a value. */
  readonly changed: readonly string[];
}

export function compare(before: Snapshot, after: Snapshot): Verdict {
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(before.hashes), ...Object.keys(after.hashes)]))
    if (before.hashes[key] !== after.hashes[key]) changed.push(key);
  for (const key of new Set([...Object.keys(before.stats), ...Object.keys(after.stats)]))
    if (before.stats[key] !== after.stats[key]) changed.push(key);
  return { unchanged: changed.length === 0, changed };
}
