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
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
const isSqliteSidecar = (path: string) => /\.sqlite-(journal|wal|shm)$/u.test(path);

/** How many times a SQLite file is copied before it is refused by name. */
export const SQLITE_COPY_TRIES = 3;
const SQLITE_SIDECARS = ['-journal', '-wal'] as const;

/** `VACUUM INTO` itself failed, as opposed to a copy that was torn. */
class VacuumFailed extends Error {}

/** A plain single-name file at `path`, or false (absent, a link, a device, hard-linked elsewhere). */
const plainFile = async (path: string): Promise<boolean> => {
  const info = await lstat(path).catch(() => undefined);
  return info !== undefined && info.isFile() && info.nlink === 1;
};

/**
 * A consistent copy of one SQLite file. bun:sqlite has no backup API, and opening v4's own database would let SQLite
 * touch it (a shared lock that can fail a v4 writer, a hot journal rolled back, a `-shm` mapped). So v4's file is never
 * opened by SQLite: the file and its `-journal` / `-wal` are copied byte for byte into a private (0700) temp folder, and
 * `VACUUM INTO` runs from THAT copy, where a hot journal is rolled back (a WAL replayed) harmlessly.
 */
export async function copySqlite(
  from: string,
  to: string,
  options: { readonly onAttempt?: (attempt: number) => void } = {},
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'fy-preview-sqlite-'));
  try {
    await chmod(scratch, 0o700);
    const copy = join(scratch, 'copy.sqlite');
    // v4 is live: the file and its sidecars are read in one pass, which a writer can tear. A copy SQLite cannot open,
    // or that fails `integrity_check`, is copied again, three tries in all. A copy that holds half a committed
    // transaction (main copied, then the writer commits and deletes its journal before the journal is copied) can still
    // pass the check: the second pass in `stage` (size or mtime moved) catches that case and copies the file again.
    // Either way a torn copy only ever breaks the preview, never v4.
    for (let attempt = 1; attempt <= SQLITE_COPY_TRIES; attempt++) {
      options.onAttempt?.(attempt);
      await rm(copy, { force: true });
      for (const suffix of SQLITE_SIDECARS) await rm(`${copy}${suffix}`, { force: true });
      await copyFile(from, copy);
      for (const suffix of SQLITE_SIDECARS)
        if (await plainFile(`${from}${suffix}`)) await copyFile(`${from}${suffix}`, `${copy}${suffix}`);
      let source: Database | undefined;
      try {
        // Not read-only: a hot journal in the COPY is rolled back (a WAL replayed) there, on first read.
        source = new Database(copy);
        const rows = source.query('PRAGMA integrity_check').all() as { integrity_check: string }[];
        if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') continue;
        // The target must not exist. The quote doubling is the SQL literal rule; the path is the tool's own.
        await rm(to, { force: true });
        try {
          source.run(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
        } catch (error) {
          // Not a torn copy (a full disk, an unwritable target): another try would fail the same way, so say why.
          throw new VacuumFailed((error as Error).message);
        }
        return;
      } catch (error) {
        if (error instanceof VacuumFailed) throw new Error(`VACUUM INTO failed: ${error.message}`);
        // A copy SQLite cannot even open is as torn as one that fails the check.
      } finally {
        source?.close();
      }
    }
    throw new Error(`failed integrity_check on ${SQLITE_COPY_TRIES} copies`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function copyOne(home: string, staging: string, path: string): Promise<void> {
  // A path can be swapped for a link, or hard-linked to a file elsewhere, after the walk: look again, right before the
  // copy, and copy only a plain file with one name.
  const info = await lstat(join(home, path));
  if (!info.isFile() || info.nlink > 1) throw new Error(`${path} is not a plain single-name file; it was not copied`);
  const target = join(staging, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (isSqlite(path)) {
    await rm(target, { force: true });
    await copySqlite(join(home, path), target).catch(error => {
      // Keep `code`: a file v4 deleted mid-copy (ENOENT) is "vanished" in `stage`, not an abort.
      const code = (error as NodeJS.ErrnoException).code;
      throw Object.assign(
        new Error(`${path} was refused: ${(error as Error).message}; nothing was copied for it`),
        code === undefined ? {} : { code },
      );
    });
  } else await copyFile(join(home, path), target);
  await chmod(target, 0o600);
}

export interface StageReport {
  readonly copied: number;
  readonly bytes: number;
  /** Files whose size or mtime moved between the walk and the second pass; each was copied again. */
  readonly changed: readonly string[];
  /** Files copied in the first pass that v4 deleted before the second: removed from the snapshot again. */
  readonly vanished: readonly string[];
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
  const present = new Set(second.files.map(file => file.path));
  const gone = first.files
    .filter(file => !isSqliteSidecar(file.path) && !present.has(file.path))
    .map(file => file.path);
  for (const path of gone) await rm(join(staging, path), { force: true });
  return {
    copied: copied.length,
    bytes: copied.reduce((sum, file) => sum + file.bytes, 0),
    changed,
    vanished: gone,
    left: second.left,
  };
}
