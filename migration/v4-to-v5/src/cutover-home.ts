/** Synchronous mutations run by the SQLite lock owner. Never yield between identity checks and a rename. */
import { appendFileSync, chmodSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exchangePaths, moveNoReplace } from './recovery-copy.ts';

interface Identity {
  readonly dev: number;
  readonly ino: number;
}
const recordPath = (lease: string) => join(lease, 'placeholder.json');
const text = (backup: string) => `migrating to Ferretry 5 — see ${backup}\n`;

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
  try {
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
      unlinkSync(recordPath(lease));
    } else if (sameLock(staged, placeholder)) {
      assertPlaceholder(lease, staged, backup);
      unlinkSync(staged);
      unlinkSync(recordPath(lease));
    }
    throw error;
  }
}

/** Never removes a replacement file (even with matching text), a symlink or a partially converted directory. */
export function restoreHome(lease: string, home: string, backup: string, mode: number): void {
  let present = false;
  try {
    lstatSync(home);
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (present) {
    assertPlaceholder(lease, home, backup);
    exchangePaths(backup, home);
    assertPlaceholder(lease, backup, backup);
    unlinkSync(backup);
  } else moveNoReplace(backup, home);
  chmodSync(home, mode);
  // The proof outlives lease release, and is removed only after a completed restoration.
  try {
    unlinkSync(recordPath(lease));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
