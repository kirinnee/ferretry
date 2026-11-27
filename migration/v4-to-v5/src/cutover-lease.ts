/** A cutover owns the SAME SQLite transaction v4 owns, across the backup and convert shell invocations. */
import { Database } from 'bun:sqlite';
import { mkdirSync, unlinkSync } from 'node:fs';
import { chmod, lstat, mkdir, rmdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertPlaceholder, moveHome, restoreHome, sameLock } from './cutover-home.ts';
import { exchangePaths } from './recovery-copy.ts';

const socketPath = (dir: string) => join(dir, 'lease.sock');

async function privateDirectory(dir: string): Promise<void> {
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    throw new Error('cutover lease is not a private folder owned by this user');
}

/** A live lease proves exclusion by the actual lock inode, even after its parent was renamed. */
export async function checkLease(dir: string, lockPath: string): Promise<boolean> {
  try {
    await privateDirectory(dir);
    const response = await fetch(`http://localhost/check?path=${encodeURIComponent(resolve(lockPath))}`, {
      unix: socketPath(dir),
      signal: AbortSignal.timeout(2000),
    });
    return response.status === 204;
  } catch {
    return false;
  }
}

export async function releaseLease(dir: string): Promise<void> {
  await privateDirectory(dir);
  const response = await fetch('http://localhost/release', {
    unix: socketPath(dir),
    method: 'POST',
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error('cutover lease could not be released');
  await removeEmptyLease(dir);
}

/** Never recurse: recovery proof and any unexpected entry stay available for inspection. */
async function removeEmptyLease(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error(`Cutover records or unrecognised entries kept at ${dir}; inspect before removing anything.`);
  }
}

async function changeHome(dir: string, action: string, args: readonly string[]): Promise<void> {
  await privateDirectory(dir);
  const response = await fetch(`http://localhost/${action}`, {
    unix: socketPath(dir),
    method: 'POST',
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(await response.text());
}

async function takeV4Lock(home: string) {
  if (!(await lstat(home)).isDirectory()) throw new Error('v4 home is not a real directory');
  const lockPath = join(home, 'daemon.lock');
  const previous = await lstat(lockPath).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (previous !== undefined && (!previous.isFile() || previous.nlink !== 1))
    throw new Error('v4 daemon lock is not a plain file');
  const db = new Database(lockPath, { create: true, strict: true });
  // v4 uses SQLite's OS-backed byte-range locks, not flock(2). A flock alone would NOT exclude a v4 restart.
  db.exec('PRAGMA journal_mode = MEMORY; PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  await chmod(lockPath, 0o600);
  const identity = await stat(lockPath);
  if (previous !== undefined && (identity.dev !== previous.dev || identity.ino !== previous.ino))
    throw new Error('v4 lock changed while taking exclusion');
  return { db, identity };
}

async function serve(home: string, dir: string): Promise<void> {
  await privateDirectory(dir);
  const { db, identity } = await takeV4Lock(home);
  let held = true;
  let target: Awaited<ReturnType<typeof takeV4Lock>> | undefined;
  let movedTo: string | undefined;
  const server = Bun.serve({
    unix: socketPath(dir),
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/check') {
        const path = url.searchParams.get('path');
        return new Response(null, {
          status:
            held &&
            path !== null &&
            (sameLock(path, identity) || (target !== undefined && sameLock(path, target.identity)))
              ? 204
              : 409,
        });
      }
      if (request.method === 'POST' && ['/move', '/prepare', '/restore'].includes(url.pathname)) {
        try {
          const [backup, notesOrMode] = (await request.json()) as string[];
          if (!held || backup === undefined) throw new Error('lease is not held');
          if (url.pathname === '/move') {
            if (movedTo !== undefined || notesOrMode === undefined) throw new Error('home already moved');
            // The same process acquired the SQLite lock, verifies its inode and performs the rename.
            moveHome(dir, home, backup, notesOrMode, identity);
            movedTo = backup;
          } else if (url.pathname === '/prepare') {
            if (movedTo !== backup || target !== undefined) throw new Error('home is not ready for conversion');
            assertPlaceholder(dir, home, backup);
            const staged = join(dir, 'new-home');
            mkdirSync(staged, { mode: 0o700 });
            target = await takeV4Lock(staged);
            // Recheck after the asynchronous lock acquisition; swap never exposes an absent or unlocked home.
            assertPlaceholder(dir, home, backup);
            exchangePaths(staged, home);
            // The last check is not proof of what the exchange actually displaced.
            try {
              assertPlaceholder(dir, staged, backup);
            } catch {
              throw new Error(
                `home changed during cutover; displaced entry kept at ${staged}; inspect before retrying`,
              );
            }
          } else {
            if (!sameLock(join(backup, 'daemon.lock'), identity) || notesOrMode === undefined)
              throw new Error('backup lock changed');
            restoreHome(dir, home, backup, parseInt(notesOrMode, 8));
          }
          return new Response(null, { status: 204 });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : 'cutover home operation refused', {
            status: 409,
          });
        }
      }
      if (url.pathname === '/release' && request.method === 'POST') {
        held = false;
        db.close(); // A successful response acknowledges the actual unlock, not a timer that might run later.
        target?.db.close();
        if (target !== undefined && sameLock(join(home, 'daemon.lock'), target.identity))
          unlinkSync(join(home, 'daemon.lock')); // Only the empty lock created for this conversion, never v4 data.
        if (target !== undefined && movedTo !== undefined) {
          const displaced = join(dir, 'new-home');
          try {
            assertPlaceholder(dir, displaced, movedTo);
            unlinkSync(displaced);
          } catch {
            // In particular this may be a replacement v4 home with its only copy of a session.
            // Leave it and the identity proof in place. The caller reports the retained directory.
          }
        }
        // Stop accepting now, letting this response finish. A delayed stop could unlink a new keeper's socket.
        void server.stop();
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
  await chmod(socketPath(dir), 0o600);
}

async function start(home: string, dir: string): Promise<void> {
  // Exclusive creation refuses a stale or planted lease; it is never reused on faith.
  await mkdir(dir, { mode: 0o700 });
  const child = Bun.spawn([process.execPath, import.meta.path, 'serve', home, dir], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env: process.env,
  });
  child.unref();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await checkLease(dir, join(home, 'daemon.lock'))) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(25);
  }
  child.kill();
  await child.exited;
  await removeEmptyLease(dir);
  throw new Error('cannot prove v4 stopped or hold its daemon lock; stop v4 and run quiet again. Nothing was moved');
}

if (import.meta.main) {
  const [command, first, second, third] = process.argv.slice(2);
  try {
    if (command === 'start' && first !== undefined && second !== undefined) await start(first, second);
    else if (command === 'serve' && first !== undefined && second !== undefined) await serve(first, second);
    else if (command === 'stopped' && first !== undefined) (await takeV4Lock(first)).db.close();
    else if (command === 'check' && first !== undefined && second !== undefined) {
      if (!(await checkLease(first, second)))
        throw new Error('cutover exclusion was lost; do not convert, roll back first');
    } else if (command === 'release' && first !== undefined) await releaseLease(first);
    else if ((command === 'move' || command === 'prepare') && first !== undefined && second !== undefined)
      await changeHome(first, command, third === undefined ? [second] : [second, third]);
    else if (command === 'restore' && first !== undefined && second !== undefined && third !== undefined) {
      const mode = process.argv[6] ?? '700';
      try {
        await changeHome(first, 'restore', [second, mode]);
      } catch {
        // A dead keeper cannot help. Reacquire the actual backup lock here before restoring anything.
        const lock = await takeV4Lock(second);
        try {
          restoreHome(first, third, second, parseInt(mode, 8));
        } finally {
          lock.db.close();
        }
      }
    } else throw new Error('invalid cutover lease command');
  } catch (error) {
    if (error instanceof Error) console.error(error.message);
    console.error(
      'Cannot prove v4 stopped and exclusively locked. Nothing was moved by this command. Stop v4 and run quiet again, or roll back if backup already moved.',
    );
    process.exitCode = 1;
  }
}
