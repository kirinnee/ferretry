/**
 * Walk a v4 home through the preview plan, and (unless it is a dry run) copy what the plan allows into a staging
 * folder. The walk reads DIRECTORY LISTINGS and `lstat` only; a file's content is read by the copy alone, and only
 * for a path the plan allowed. A folder the plan leaves is counted and never listed: nothing under
 * `fleet/credentials` or `fleet/homes` is ever enumerated.
 *
 * The v4 home is live. The copy is a point in time per file; a second pass finds the files that changed during the
 * first and copies them again, and every file that changed between the passes is reported by name.
 */
import { Database } from 'bun:sqlite';
import { chmod, copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decide } from './plan.ts';

export interface LeftOut {
  readonly path: string;
  readonly why: string;
  readonly folder: boolean;
}

export interface Walked {
  /** Allowed files, relative to the v4 home, with the size and mtime seen at the walk. */
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly mtimeMs: number }[];
  /** What was left, at the first level the plan refused (a refused folder is one row, never listed). */
  readonly left: readonly LeftOut[];
}

/** Which allowed folders the walk looks inside, for the report: `state/sessions` is a thousand folders of one shape. */
export async function walk(home: string): Promise<Walked> {
  const files: { path: string; bytes: number; mtimeMs: number }[] = [];
  const left: LeftOut[] = [];

  const visit = async (relative: string): Promise<void> => {
    const entries = await readdir(join(home, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      // Links, sockets and devices are never followed or copied: a link can point anywhere.
      if (entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) {
        left.push({ path, why: 'a link, socket or device is never followed', folder: false });
        continue;
      }
      const decision = decide(path, entry.isDirectory());
      if (decision.verdict === 'leave') left.push({ path, why: decision.why, folder: entry.isDirectory() });
      else if (decision.verdict === 'descend') await visit(path);
      else {
        const info = await lstat(join(home, path));
        files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
      }
    }
  };
  await visit('');
  return { files, left };
}

const isSqlite = (path: string) => /\.sqlite$/u.test(path);
const isSqliteSidecar = (path: string) => /\.sqlite-(wal|shm)$/u.test(path);

/** A consistent copy of one SQLite file through the engine (`VACUUM INTO`), so a live writer never tears it. */
export function copySqlite(from: string, to: string): void {
  const source = new Database(from, { readonly: true });
  try {
    // The target must not exist. The quote doubling is the SQL literal rule; the path is the tool's own.
    source.run(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
}

async function copyOne(home: string, staging: string, path: string): Promise<void> {
  const target = join(staging, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (isSqlite(path)) {
    await rm(target, { force: true });
    copySqlite(join(home, path), target);
  } else await copyFile(join(home, path), target);
  await chmod(target, 0o600);
}

export interface StageReport {
  readonly copied: number;
  readonly bytes: number;
  /** Files whose size or mtime moved between the walk and the second pass; each was copied again. */
  readonly changed: readonly string[];
  readonly left: readonly LeftOut[];
}

/** Copy the allowed files of `home` into `staging` (a new folder), then run the second pass. */
export async function stage(home: string, staging: string): Promise<StageReport> {
  const first = await walk(home);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const vanished = new Set<string>();
  for (const file of first.files) {
    if (isSqliteSidecar(file.path)) continue;
    await copyOne(home, staging, file.path).catch(error => {
      // A file that disappeared mid-copy was deleted by the live v4: it is simply not in the snapshot.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') vanished.add(file.path);
      else throw error;
    });
  }

  const changed: string[] = [];
  const second = await walk(home);
  const seen = new Map(first.files.map(file => [file.path, file]));
  for (const file of second.files) {
    if (isSqliteSidecar(file.path)) continue;
    const before = seen.get(file.path);
    if (
      before !== undefined &&
      before.bytes === file.bytes &&
      before.mtimeMs === file.mtimeMs &&
      !vanished.has(file.path)
    )
      continue;
    changed.push(file.path);
    await copyOne(home, staging, file.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  const copied = second.files.filter(file => !isSqliteSidecar(file.path));
  return {
    copied: copied.length,
    bytes: copied.reduce((sum, file) => sum + file.bytes, 0),
    changed,
    left: second.left,
  };
}
