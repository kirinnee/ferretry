/**
 * Conversation leases on a REAL state folder: the kernel's real state port for the writes, real files and a real
 * `flock(2)` for the lock, real processes for "who is still running". Everything is a temp folder.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import { type FileLock, flockRefusal, loadFileLock } from '../../../../cli/adapters/history/file-lock.ts';
import { HostProcessStarts, procStatStart, psStart } from '../../../../cli/adapters/history/host-process-starts.ts';
import { StateLeaseDisk } from '../../../../cli/adapters/history/state-lease-disk.ts';
import {
  ConversationIdSchema,
  ConversationLeaseStore,
  MAX_LEASE_BYTES,
} from '../../../../contract/conversation-lease.ts';
import manifest from '../../../../manifest.ts';

const CONVERSATION = ConversationIdSchema.parse('0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21');
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}

async function home() {
  const root = await temp('fy-leases-');
  const port = state.createStatePort({
    home: root,
    pluginId: 'ferrets',
    files: manifest.data.state,
    fs: state.createNodeHostFs(),
  });
  const tree = join(root, 'state', 'ferrets', 'conversation-leases');
  return { port, tree, pool: join(tree, 'claude') };
}

const real = new HostProcessStarts(process.platform);

describe('StateLeaseDisk files', () => {
  it('should write a lease through the state port as an owner-only file, read it back, list it and remove it', async () => {
    // Arrange
    const { port, pool } = await home();
    const disk = new StateLeaseDisk(port, real);

    // Act
    await disk.write('claude', CONVERSATION, '{"v":1}\n');
    const read = await disk.read('claude', CONVERSATION);
    const listed = await disk.list('claude');
    const mode = (await stat(join(pool, `${CONVERSATION}.lease`))).mode & 0o777;
    await disk.remove('claude', CONVERSATION);

    // Assert
    should(read).equal('{"v":1}\n');
    should(listed).eql([CONVERSATION]);
    should(mode).equal(0o600);
    should(await disk.read('claude', CONVERSATION)).be.undefined();
    should(await disk.list('claude')).be.empty();
  });

  it('should answer nothing, not an error, for a conversation or a pool that was never written', async () => {
    // Arrange
    const { port } = await home();
    const disk = new StateLeaseDisk(port, real);

    // Act
    const read = await disk.read('codex', CONVERSATION);
    const listed = await disk.list('codex');

    // Assert
    should(read).be.undefined();
    should(listed).eql([]);
  });

  it('should list only lease files, never the lock or a temporary', async () => {
    // Arrange
    const { port, pool } = await home();
    const disk = new StateLeaseDisk(port, real);
    await disk.write('claude', CONVERSATION, 'x');
    await disk.exclusive('claude', async () => undefined);
    await writeFile(join(pool, '.leftover.tmp'), 'x');

    // Act
    const listed = await disk.list('claude');

    // Assert
    should((await readdir(pool)).sort()).eql(['.leftover.tmp', `${CONVERSATION}.lease`, 'pool.lock']);
    should(listed).eql([CONVERSATION]);
  });

  it('should not read a lease larger than a lease can be', async () => {
    // Arrange
    const { port, pool } = await home();
    const disk = new StateLeaseDisk(port, real);
    await disk.write('claude', CONVERSATION, 'x'.repeat(MAX_LEASE_BYTES + 1));
    await disk.write('claude', ConversationIdSchema.parse('exact'), 'y'.repeat(MAX_LEASE_BYTES));

    // Act
    const tooBig = await disk.read('claude', CONVERSATION);
    const exact = await disk.read('claude', ConversationIdSchema.parse('exact'));

    // Assert
    should(tooBig).be.undefined();
    should(exact?.length).equal(MAX_LEASE_BYTES);
    should((await stat(join(pool, `${CONVERSATION}.lease`))).size).equal(MAX_LEASE_BYTES + 1);
  });

  it('should refuse a lease name that is a link, never following it', async () => {
    // Arrange
    const { port, pool } = await home();
    const disk = new StateLeaseDisk(port, real);
    await disk.exclusive('claude', async () => undefined);
    const outside = await temp('fy-leases-outside-');
    await writeFile(join(outside, 'secret'), 'do not read me');
    await symlink(join(outside, 'secret'), join(pool, `${CONVERSATION}.lease`));

    // Act
    const reading = disk.read('claude', CONVERSATION);

    // Assert
    await should(reading).be.rejected();
  });

  it('should refuse a lease name that is something other than a regular file', async () => {
    // Arrange
    const { port, pool } = await home();
    const disk = new StateLeaseDisk(port, real);
    await disk.exclusive('claude', async () => undefined);
    await mkdir(join(pool, `${CONVERSATION}.lease`));

    // Act
    const reading = disk.read('claude', CONVERSATION);

    // Assert
    await should(reading).be.rejectedWith(`the lease for ${CONVERSATION} is not a regular file`);
  });

  it('should say a pool folder that is not a folder is broken rather than empty', async () => {
    // Arrange
    const { port, tree } = await home();
    const disk = new StateLeaseDisk(port, real);
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'claude'), 'not a folder');

    // Act
    const listing = disk.list('claude');

    // Assert
    await should(listing).be.rejected();
  });

  it('should hand the process start to whoever decides', async () => {
    // Arrange
    const { port } = await home();
    const disk = new StateLeaseDisk(port, { startOf: async pid => pid * 2 });

    // Act
    const start = await disk.startOf(21);

    // Assert
    should(start).equal(42);
  });
});

describe('StateLeaseDisk lock', () => {
  it('should make the lock beside the leases as an owner-only file and run the work', async () => {
    // Arrange
    const { port, pool } = await home();
    const disk = new StateLeaseDisk(port, real);

    // Act
    const answer = await disk.exclusive('claude', async () => 'done');

    // Assert
    should(answer).equal('done');
    should((await stat(join(pool, 'pool.lock'))).mode & 0o777).equal(0o600);
  });

  it('should make a second claimant of the same pool wait for the first to finish, never overlap it', async () => {
    // Arrange
    const { port } = await home();
    const first = new StateLeaseDisk(port, real);
    const second = new StateLeaseDisk(port, real);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });

    // Act
    const holding = first.exclusive('claude', async () => {
      order.push('first in');
      await held;
      order.push('first out');
    });
    await Bun.sleep(30);
    const waiting = second.exclusive('claude', async () => {
      order.push('second in');
    });
    await Bun.sleep(60);
    order.push('released');
    release();
    await Promise.all([holding, waiting]);

    // Assert
    should(order).eql(['first in', 'released', 'first out', 'second in']);
  });

  it('should let the pools of two harnesses be held at once', async () => {
    // Arrange
    const { port } = await home();
    const disk = new StateLeaseDisk(port, real, { waitMs: 100 });

    // Act
    const both = await disk.exclusive('claude', async () => await disk.exclusive('codex', async () => 'both'));

    // Assert
    should(both).equal('both');
  });

  it('should give up with a sentence once the wait is spent, and leave the holder alone', async () => {
    // Arrange
    const { port } = await home();
    const holder = new StateLeaseDisk(port, real);
    const impatient = new StateLeaseDisk(port, real, { waitMs: 40, pollMs: 5 });
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const holding = holder.exclusive('claude', async () => await held);
    await Bun.sleep(30);

    // Act
    const waiting = impatient.exclusive('claude', async () => 'never');

    // Assert
    await should(waiting).be.rejectedWith(
      'the conversation lease store stayed busy: another claimant held its lock for 40 ms',
    );
    release();
    await holding;
  });

  it('should free the lock when the work throws, so the next claimant is not wedged', async () => {
    // Arrange
    const { port } = await home();
    const disk = new StateLeaseDisk(port, real, { waitMs: 200 });

    // Act
    const failing = disk.exclusive('claude', async () => {
      throw new Error('boom');
    });
    await should(failing).be.rejectedWith('boom');
    const next = await disk.exclusive('claude', async () => 'next');

    // Assert
    should(next).equal('next');
  });

  it('should refuse the claim when the lock cannot be loaded here, saying why', async () => {
    // Arrange
    const { port } = await home();
    const disk = new StateLeaseDisk(port, real, {
      loadLock: () => {
        throw new Error('no libc');
      },
    });

    // Act
    const claiming = disk.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejectedWith('the conversation lease lock could not be loaded here (no libc)');
  });

  it('should say a lock that failed for a reason that is not an Error as text', async () => {
    // Arrange
    const { port } = await home();
    const disk = new StateLeaseDisk(port, real, {
      loadLock: () => {
        throw 'plain text';
      },
    });

    // Act
    const claiming = disk.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejectedWith(/could not be loaded here \(plain text\)/u);
  });

  it('should refuse a pool folder that is a link, so a lease can never be redirected', async () => {
    // Arrange
    const { port, tree, pool } = await home();
    const outside = await temp('fy-leases-redirect-');
    await mkdir(tree, { recursive: true });
    await symlink(outside, pool);
    const disk = new StateLeaseDisk(port, real);

    // Act
    const claiming = disk.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejectedWith(/is not a plain folder/u);
    should(await readdir(outside)).be.empty();
  });

  it('should refuse a lease tree that is a link, so the pool above it cannot be redirected either', async () => {
    // Arrange
    const { port, tree } = await home();
    const outside = await temp('fy-leases-redirect-');
    await mkdir(join(outside, 'claude'), { recursive: true });
    await mkdir(join(tree, '..'), { recursive: true });
    await symlink(outside, tree);
    const disk = new StateLeaseDisk(port, real);

    // Act
    const claiming = disk.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejectedWith(/is not a plain folder/u);
    should(await readdir(join(outside, 'claude'))).be.empty();
  });

  it('should refuse a lock name that is a link, never following it', async () => {
    // Arrange
    const { port, pool } = await home();
    const outside = await temp('fy-leases-redirect-');
    await writeFile(join(outside, 'target'), 'x');
    await mkdir(pool, { recursive: true });
    await symlink(join(outside, 'target'), join(pool, 'pool.lock'));
    const disk = new StateLeaseDisk(port, real);

    // Act
    const claiming = disk.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejected();
  });

  it('should refuse a lock name that is not a regular file', async () => {
    // Arrange
    const { port, pool } = await home();
    await mkdir(pool, { recursive: true });
    const made = Bun.spawnSync(['mkfifo', join(pool, 'pool.lock')]);
    should(made.exitCode).equal(0);
    const disk = new StateLeaseDisk(port, real);

    // Act
    const claiming = disk.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejectedWith('refusing the conversation lease lock: it is not a regular file');
  });
});

describe('flock', () => {
  it('should exclude a second open of the same file, even in one process, until the first is closed', async () => {
    // Arrange
    const folder = await temp('fy-flock-');
    const path = join(folder, 'lock');
    await writeFile(path, '');
    const lock: FileLock = loadFileLock();
    const { open } = await import('node:fs/promises');
    const first = await open(path, 'r+');
    const second = await open(path, 'r+');

    // Act
    const took = lock.tryLock(first.fd);
    const refused = lock.tryLock(second.fd);
    await first.close();
    const afterClose = lock.tryLock(second.fd);
    await second.close();

    // Assert
    should([took, refused, afterClose]).eql([true, false, true]);
  });

  it('should throw, not read as held, for a descriptor that is not open', () => {
    // Arrange
    const lock = loadFileLock();

    // Act
    const locking = (): boolean => lock.tryLock(987_654);

    // Assert
    should(locking).throw(/errno \d+: flock 987654/u);
  });

  it('should ask again after a signal and call a busy lock held, and refuse anything else', () => {
    // Assert
    should(flockRefusal(4, 3)).equal('again');
    should(flockRefusal(11, 3)).equal('held');
    should(() => flockRefusal(9, 3)).throw('errno 9: flock 3');
  });
});

describe('HostProcessStarts', () => {
  it('should read the start of this process, the same on every read', async () => {
    // Act
    const first = await real.startOf(process.pid);
    const again = await real.startOf(process.pid);

    // Assert
    should(first).be.a.Number();
    should(again).equal(first);
  });

  it('should tell two processes apart, and a process that has ended from one that is running', async () => {
    // Arrange
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    const runningStart = await real.startOf(child.pid);
    child.kill();
    await child.exited;

    // Act
    const ended = await real.startOf(child.pid);

    // Assert
    should(runningStart).be.a.Number();
    should(ended).be.undefined();
  });

  it('should answer nothing for a pid that is not a pid', async () => {
    // Assert
    should(await real.startOf(0)).be.undefined();
    should(await real.startOf(-4)).be.undefined();
    should(await real.startOf(1.5)).be.undefined();
  });

  it('should read the start from field 22 of a stat line whose command name holds spaces and brackets', () => {
    // Arrange
    const fields = Array.from({ length: 49 }, (_, index) => String(index + 3));
    fields[19] = '123456';
    const line = `4242 (my (odd) cmd) ${fields.join(' ')}`;

    // Act
    const start = procStatStart(line);

    // Assert
    should(start).equal(123456);
    should(procStatStart('4242 (cmd) S 1 2')).be.undefined();
    should(procStatStart('garbage')).be.undefined();
  });

  it('should read epoch seconds from the ps start column and refuse anything else', () => {
    // Assert
    should(psStart('Sat Sep  6 18:48:09 2026\n')).equal(Date.UTC(2026, 8, 6, 18, 48, 9) / 1000);
    should(psStart('\n')).be.undefined();
    should(psStart('not a date')).be.undefined();
  });

  it('should ask ps by absolute path off Linux, and answer nothing when ps fails', async () => {
    // Arrange
    const folder = await temp('fy-ps-');
    const good = join(folder, 'ps-good');
    const bad = join(folder, 'ps-bad');
    await writeFile(good, '#!/bin/sh\necho "Sat Sep  6 18:48:09 2026"\n');
    await writeFile(bad, '#!/bin/sh\nexit 1\n');
    await chmod(good, 0o755);
    await chmod(bad, 0o755);

    // Act
    const found = await new HostProcessStarts('darwin', '/proc', good).startOf(4242);
    const missing = await new HostProcessStarts('darwin', '/proc', bad).startOf(4242);

    // Assert
    should(found).equal(Date.UTC(2026, 8, 6, 18, 48, 9) / 1000);
    should(missing).be.undefined();
  });
});

describe('ConversationLeaseStore over real files', () => {
  it('should refuse a second live writer, name it, and take the conversation over once the first has ended', async () => {
    // Arrange
    const { port, pool } = await home();
    const store = new ConversationLeaseStore(
      new StateLeaseDisk(port, real),
      () => new Date('2026-11-15T10:00:00.000Z'),
    );
    const unknown = async () => 'unknown' as const;
    const sleeper = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });

    // Act
    const first = await store.claim(
      { harness: 'claude', conversation: CONVERSATION, holder: { pid: sleeper.pid } },
      unknown,
    );
    const second = await store.claim(
      { harness: 'claude', conversation: CONVERSATION, holder: { pid: process.pid, runtime: 'other' } },
      unknown,
    );
    sleeper.kill();
    await sleeper.exited;
    const third = await store.claim(
      { harness: 'claude', conversation: CONVERSATION, holder: { pid: process.pid } },
      unknown,
    );

    // Assert
    should(first.kind).equal('claimed');
    should(second.kind).equal('held');
    should(second.lease.holder.pid).equal(sleeper.pid);
    should(third.kind === 'claimed' && third.decision).equal('take-over');
    const written = JSON.parse(await Bun.file(join(pool, `${CONVERSATION}.lease`)).text()) as {
      holder: { pid: number };
    };
    should(written.holder.pid).equal(process.pid);
  });

  it('should release only what one session holds', async () => {
    // Arrange
    const { port } = await home();
    const disk = new StateLeaseDisk(port, real);
    const store = new ConversationLeaseStore(disk, () => new Date());
    const unknown = async () => 'unknown' as const;
    const other = ConversationIdSchema.parse('other-conversation');
    await store.claim(
      { harness: 'claude', conversation: CONVERSATION, holder: { pid: process.pid, session: 's-1' } },
      unknown,
    );
    await store.claim(
      { harness: 'claude', conversation: other, holder: { pid: process.pid, session: 's-2' } },
      unknown,
    );

    // Act
    const released = await store.releaseSession('s-1');

    // Assert
    should(released).eql([CONVERSATION]);
    should(await disk.list('claude')).eql([other]);
  });
});
