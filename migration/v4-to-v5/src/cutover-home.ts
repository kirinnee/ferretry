/** Synchronous mutations run by the SQLite lock owner. Never yield between identity checks and a rename. */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { exchangePaths, moveNoReplace } from './recovery-copy.ts';

interface Identity {
  readonly dev: number;
  readonly ino: number;
}
const recordPath = (lease: string) => join(lease, 'placeholder.json');
const journalPath = (lease: string) => join(lease, 'exchanged.json');
const text = (backup: string) => `migrating to Ferretry 5 — see ${backup}\n`;

function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Written and flushed BEFORE the exchange, so even SIGKILL cannot lose the displaced home's identity. */
interface ExchangeJournal {
  readonly phase: 'exchanged';
  readonly home: string;
  readonly backup: string;
  readonly directory: Identity;
  readonly lock: Identity;
}

export function interruptedHome(lease: string, home: string, backup: string): string | undefined {
  let journal: ExchangeJournal;
  try {
    journal = JSON.parse(readFileSync(journalPath(lease), 'utf8')) as ExchangeJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (journal.phase !== 'exchanged' || journal.home !== home || journal.backup !== backup)
    throw new Error('cutover journal paths or phase changed');
  const staged = join(lease, 'old-home');
  let entry;
  try {
    entry = lstatSync(staged);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  // A crash before the exchange leaves only our prepared placeholder here.
  if (entry.isFile()) {
    assertPlaceholder(lease, staged, backup);
    const original = lstatSync(home);
    if (
      original.isDirectory() &&
      original.dev === journal.directory.dev &&
      original.ino === journal.directory.ino &&
      sameLock(join(home, 'daemon.lock'), journal.lock)
    )
      return undefined;
  }
  if (
    !entry.isDirectory() ||
    entry.dev !== journal.directory.dev ||
    entry.ino !== journal.directory.ino ||
    !sameLock(join(staged, 'daemon.lock'), journal.lock)
  )
    throw new Error(`interrupted cutover home identity changed; entry kept at ${staged}; inspect before recovery`);
  assertPlaceholder(lease, home, backup);
  return staged;
}

function clearProof(lease: string): void {
  for (const path of [recordPath(lease), journalPath(lease)]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  syncPath(lease);
}

export function sameLock(path: string, identity: Identity): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && info.dev === identity.dev && info.ino === identity.ino;
  } catch {
    return false;
  }
}

export function assertPlaceholder(lease: string, home: string, backup: string): void {
  const identity = JSON.parse(readFileSync(recordPath(lease), 'utf8')) as Identity;
  if (!sameLock(home, identity) || readFileSync(home, 'utf8') !== text(backup))
    throw new Error(`the cutover placeholder changed; entry kept at ${home}; inspect before rollback`);
}

/** Any error after moving restores the original home before the keeper can release its lock. */
export function moveHome(lease: string, home: string, backup: string, notes: string, identity: Identity): void {
  if (!sameLock(join(home, 'daemon.lock'), identity)) throw new Error('cutover exclusion was lost');
  const staged = join(lease, 'old-home');
  writeFileSync(staged, text(backup), { flag: 'wx', mode: 0o600 });
  const placeholder = lstatSync(staged);
  writeFileSync(recordPath(lease), JSON.stringify({ dev: placeholder.dev, ino: placeholder.ino }), {
    flag: 'wx',
    mode: 0o600,
  });
  let displaced: string | undefined;
  let journalWritten = false;
  try {
    const directory = lstatSync(home);
    writeFileSync(
      journalPath(lease),
      JSON.stringify({
        phase: 'exchanged',
        home,
        backup,
        directory: { dev: directory.dev, ino: directory.ino },
        lock: { dev: identity.dev, ino: identity.ino },
      }),
      { flag: 'wx', mode: 0o600 },
    );
    journalWritten = true;
    for (const path of [staged, recordPath(lease), journalPath(lease), lease, dirname(lease)]) syncPath(path);
    if (!sameLock(join(home, 'daemon.lock'), identity)) throw new Error('cutover exclusion was lost');
    // The placeholder and home swap in one kernel operation: v4 can never bootstrap into a gap.
    exchangePaths(staged, home);
    if (!sameLock(join(staged, 'daemon.lock'), identity))
      throw new Error(`home changed during cutover; displaced entry kept at ${staged}; inspect before retrying`);
    displaced = staged;
    moveNoReplace(staged, backup);
    displaced = backup;
    appendFileSync(notes, '# backed-up\n');
  } catch (error) {
    if (displaced !== undefined) {
      assertPlaceholder(lease, home, backup);
      exchangePaths(displaced, home);
      // A replacement raced the exchange: preserve it at its new path and report it, never delete it.
      assertPlaceholder(lease, displaced, backup);
      unlinkSync(displaced);
      clearProof(lease);
    } else if (sameLock(staged, placeholder)) {
      assertPlaceholder(lease, staged, backup);
      unlinkSync(staged);
      if (journalWritten) clearProof(lease);
      else unlinkSync(recordPath(lease));
    }
    throw error;
  }
}

/** Never removes a replacement file (even with matching text), a symlink or a partially converted directory. */
export function restoreHome(
  lease: string,
  home: string,
  backup: string,
  mode: number,
  placeholderBackup = backup,
): void {
  let present = false;
  try {
    lstatSync(home);
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (present) {
    assertPlaceholder(lease, home, placeholderBackup);
    exchangePaths(backup, home);
    assertPlaceholder(lease, backup, placeholderBackup);
    unlinkSync(backup);
  } else moveNoReplace(backup, home);
  chmodSync(home, mode);
  // The proof outlives lease release, and is removed only after a completed restoration.
  clearProof(lease);
}
