/** A cutover owns the SAME SQLite transaction v4 owns, across the backup and convert shell invocations. */
import { Database } from 'bun:sqlite';
import { chmod, lstat, mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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
  await rm(dir, { recursive: true });
}

async function serve(home: string, dir: string): Promise<void> {
  await privateDirectory(dir);
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
  let held = true;
  const server = Bun.serve({
    unix: socketPath(dir),
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/check') {
        const path = url.searchParams.get('path');
        const info = path === null ? undefined : await lstat(path).catch(() => undefined);
        return new Response(null, {
          status: held && info?.isFile() === true && info.dev === identity.dev && info.ino === identity.ino ? 204 : 409,
        });
      }
      if (url.pathname === '/release' && request.method === 'POST') {
        held = false;
        db.close(); // A successful response acknowledges the actual unlock, not a timer that might run later.
        setTimeout(() => {
          server.stop(true);
        }, 50);
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
  await rm(dir, { recursive: true, force: true });
  throw new Error('cannot prove v4 stopped or hold its daemon lock; stop v4 and run quiet again. Nothing was moved');
}

if (import.meta.main) {
  const [command, first, second] = process.argv.slice(2);
  try {
    if (command === 'start' && first !== undefined && second !== undefined) await start(first, second);
    else if (command === 'serve' && first !== undefined && second !== undefined) await serve(first, second);
    else if (command === 'check' && first !== undefined && second !== undefined) {
      if (!(await checkLease(first, second)))
        throw new Error('cutover exclusion was lost; do not convert, roll back first');
    } else if (command === 'release' && first !== undefined) await releaseLease(first);
    else throw new Error('invalid cutover lease command');
  } catch {
    console.error(
      'Cannot prove v4 stopped and exclusively locked. Nothing was moved by this command. Stop v4 and run quiet again, or roll back if backup already moved.',
    );
    process.exitCode = 1;
  }
}
