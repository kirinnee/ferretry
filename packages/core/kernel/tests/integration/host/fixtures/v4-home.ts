import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A Ferretry 4 state home as 4.291.9 leaves it: the `layout-version` marker (no `home.json`), a log the service manager
 * appends to, state, credentials, a token, a monitor file and a plain FILE named `tmux.sock`. Fake contents only.
 */
export function writeV4Home(home: string): void {
  mkdirSync(join(home, 'logs'), { recursive: true });
  mkdirSync(join(home, 'state'), { recursive: true });
  mkdirSync(join(home, 'fleet/credentials/x'), { recursive: true });
  writeFileSync(join(home, 'layout-version'), '2\n');
  writeFileSync(join(home, 'logs/fyd.log'), 'fyd 4.291.9 ready\n');
  writeFileSync(join(home, 'state/secrets.json'), '{"fake":"not a secret"}\n', { mode: 0o600 });
  writeFileSync(join(home, 'fleet/credentials/x/token'), 'fake-credential\n', { mode: 0o600 });
  writeFileSync(join(home, 'api-token'), 'fake-api-token\n', { mode: 0o600 });
  writeFileSync(join(home, 'monitor.json'), '{"fake":true}\n');
  writeFileSync(join(home, 'tmux.sock'), 'not a socket\n');
}

export interface Entry {
  readonly type: 'dir' | 'file' | 'other';
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string | undefined;
}

/** Every entry under `home` (itself included): path, type, mode, size, mtime and content hash. */
export function snapshotTree(home: string): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  const visit = (path: string, label: string): void => {
    const stat = lstatSync(path);
    const type = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
    out[label] = {
      type,
      mode: stat.mode & 0o7777,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: type === 'file' ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined,
    };
    if (type === 'dir')
      for (const name of readdirSync(path).sort()) visit(join(path, name), label === '.' ? name : `${label}/${name}`);
  };
  visit(home, '.');
  return out;
}
