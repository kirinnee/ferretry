/** Synchronous mutations run by the SQLite lock owner. Never yield between identity checks and a rename. */
import { appendFileSync, chmodSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { moveNoReplace } from './recovery-copy.ts';

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
    throw new Error('the cutover placeholder changed; leave it alone and inspect before rollback');
}

/** Any error after moving restores the original home before the keeper can release its lock. */
export function moveHome(lease: string, home: string, backup: string, notes: string, identity: Identity): void {
  if (!sameLock(join(home, 'daemon.lock'), identity)) throw new Error('cutover exclusion was lost');
  moveNoReplace(home, backup);
  let placeholder: Identity | undefined;
  try {
    writeFileSync(home, text(backup), { flag: 'wx', mode: 0o600 });
    placeholder = lstatSync(home);
    writeFileSync(recordPath(lease), JSON.stringify({ dev: placeholder.dev, ino: placeholder.ino }), {
      flag: 'wx',
      mode: 0o600,
    });
    appendFileSync(notes, '# backed-up\n');
  } catch (error) {
    if (placeholder !== undefined && sameLock(home, placeholder) && readFileSync(home, 'utf8') === text(backup))
      unlinkSync(home);
    moveNoReplace(backup, home);
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
    unlinkSync(home);
  }
  moveNoReplace(backup, home);
  chmodSync(home, mode);
}
