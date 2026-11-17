/**
 * The daemon's conversation lease disk on a REAL state folder: the kernel's real state port, real files, a real
 * `flock(2)`. It must decide against the SAME files as `fy history claim`, so the last block runs both programs' disks
 * over one folder. Everything is a temp folder.
 */
import { afterEach, describe, it } from 'bun:test';
import { open, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import { HostProcessStarts } from '../../../../../cli/adapters/history/host-process-starts.ts';
import { StateLeaseDisk } from '../../../../../cli/adapters/history/state-lease-disk.ts';
import {
  ConversationIdSchema,
  ConversationLeaseHeldError,
  ConversationLeaseStore,
  MAX_LEASE_BYTES,
} from '../../../../../contract/conversation-lease.ts';
import { ConversationLeaseStateDisk } from '../../../../../daemon/adapters/session/lifecycle/conversation-lease-disk.ts';
import {
  type ConversationLeaseLock,
  flockRefusal,
  loadConversationLeaseLock,
} from '../../../../../daemon/adapters/session/lifecycle/conversation-lease-lock.ts';
import { ConversationLeases } from '../../../../../daemon/lib/session/lifecycle/conversation-leases.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import manifest from '../../../../../manifest.ts';

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
  const root = await temp('fy-daemon-leases-');
  const port = state.createStatePort({
    home: root,
    pluginId: 'ferrets',
    files: manifest.data.state,
    fs: state.createNodeHostFs(),
  });
  const tree = join(root, 'state', 'ferrets', 'conversation-leases');
  return { port, tree, pool: join(tree, 'claude') };
}

const processes = new HostProcessStarts(process.platform);
/** The kernel's clock, as the wait for the lock reads it. */
const clock = { nowMs: () => Date.now(), sleep: async (ms: number) => await Bun.sleep(ms) };
const disk = (port: Awaited<ReturnType<typeof home>>['port'], options = {}) =>
  new ConversationLeaseStateDisk(port, processes, clock, process.platform, options);

describe('ConversationLeaseStateDisk files', () => {
  it('should write a lease through the state port as an owner-only file, read it back, list it and remove it', async () => {
    // Arrange
    const { port, pool } = await home();
    const subject = disk(port);

    // Act
    await subject.write('claude', CONVERSATION, '{"v":1}\n');
    const read = await subject.read('claude', CONVERSATION);
    const listed = await subject.list('claude');
    const mode = (await stat(join(pool, `${CONVERSATION}.lease`))).mode & 0o777;
    await subject.remove('claude', CONVERSATION);

    // Assert
    should(read).equal('{"v":1}\n');
    should(listed).eql([CONVERSATION]);
    should(mode).equal(0o600);
    should(await subject.read('claude', CONVERSATION)).be.undefined();
    should(await subject.list('claude')).be.empty();
  });

  it('should answer nothing, not an error, for a conversation or a pool that was never written', async () => {
    // Arrange
    const { port } = await home();
    const subject = disk(port);

    // Act
    const read = await subject.read('codex', CONVERSATION);
    const listed = await subject.list('codex');

    // Assert
    should(read).be.undefined();
    should(listed).eql([]);
  });

  it('should list only lease FILES, never the lock, a temporary, or a link or folder wearing a lease name', async () => {
    // Arrange
    const { port, pool } = await home();
    const subject = disk(port);
    await subject.write('claude', CONVERSATION, 'x');
    await subject.exclusive('claude', async () => undefined);
    await writeFile(join(pool, '.leftover.tmp'), 'x');
    await symlink('/nonexistent', join(pool, 'linked.lease'));
    await mkdir(join(pool, 'folder.lease'));

    // Act
    const listed = await subject.list('claude');

    // Assert
    should(listed).eql([CONVERSATION]);
  });

  it('should not read a lease larger than a lease can be', async () => {
    // Arrange
    const { port, pool } = await home();
    const subject = disk(port);
    await subject.write('claude', CONVERSATION, 'x'.repeat(MAX_LEASE_BYTES + 1));
    await subject.write('claude', ConversationIdSchema.parse('exact'), 'y'.repeat(MAX_LEASE_BYTES));

    // Act
    const tooBig = await subject.read('claude', CONVERSATION);
    const exact = await subject.read('claude', ConversationIdSchema.parse('exact'));

    // Assert
    should(tooBig).be.undefined();
    should(exact?.length).equal(MAX_LEASE_BYTES);
    should((await stat(join(pool, `${CONVERSATION}.lease`))).size).equal(MAX_LEASE_BYTES + 1);
  });

  it('should refuse a lease name that is a link, never following it', async () => {
    // Arrange
    const { port, pool } = await home();
    const subject = disk(port);
    await subject.exclusive('claude', async () => undefined);
    const outside = await temp('fy-daemon-leases-outside-');
    await writeFile(join(outside, 'secret'), 'do not read me');
    await symlink(join(outside, 'secret'), join(pool, `${CONVERSATION}.lease`));

    // Act
    const reading = subject.read('claude', CONVERSATION);

    // Assert
    await should(reading).be.rejected();
  });

  it('should refuse a lease name that is something other than a regular file', async () => {
    // Arrange
    const { port, pool } = await home();
    const subject = disk(port);
    await subject.exclusive('claude', async () => undefined);
    await mkdir(join(pool, `${CONVERSATION}.lease`));

    // Act
    const reading = subject.read('claude', CONVERSATION);

    // Assert
    await should(reading).be.rejectedWith(`the lease for ${CONVERSATION} is not a regular file`);
  });

  it('should hand the process start to whoever decides', async () => {
    // Arrange
    const { port } = await home();
    const subject = new ConversationLeaseStateDisk(port, { startOf: async pid => pid * 2 }, clock, process.platform);

    // Act
    const start = await subject.startOf(21);

    // Assert
    should(start).equal(42);
  });
});

describe('ConversationLeaseStateDisk lock', () => {
  it('should make the lock beside the leases as an owner-only file and run the work', async () => {
    // Arrange
    const { port, pool } = await home();
    const subject = disk(port);

    // Act
    const answer = await subject.exclusive('claude', async () => 'done');

    // Assert
    should(answer).equal('done');
    should((await stat(join(pool, 'pool.lock'))).mode & 0o777).equal(0o600);
  });

  it('should make a second claimant of the same pool wait for the first to finish, never overlap it', async () => {
    // Arrange
    const { port } = await home();
    const first = disk(port);
    const second = disk(port);
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

  it('should queue two claimants of ONE disk in this process without ever polling the lock or its clock', async () => {
    // Arrange — two launches at the same instant must not busy-wait on the kernel clock (a driven clock never wakes them)
    const { port } = await home();
    let sleeps = 0;
    const counting = {
      nowMs: () => Date.now(),
      sleep: async (ms: number) => {
        sleeps += 1;
        await Bun.sleep(ms);
      },
    };
    const subject = new ConversationLeaseStateDisk(port, processes, counting, process.platform);
    const order: string[] = [];

    // Act
    const first = subject.exclusive('claude', async () => {
      order.push('first in');
      await Bun.sleep(30);
      order.push('first out');
    });
    const second = subject.exclusive('claude', async () => {
      order.push('second in');
    });
    await Promise.all([first, second]);

    // Assert
    should(order).eql(['first in', 'first out', 'second in']);
    should(sleeps).equal(0);
  });

  it('should give up with a sentence once the wait is spent, and leave the holder alone', async () => {
    // Arrange
    const { port } = await home();
    const holder = disk(port);
    const impatient = disk(port, { waitMs: 40, pollMs: 5 });
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
    const subject = disk(port, { waitMs: 200 });

    // Act
    const failing = subject.exclusive('claude', async () => {
      throw new Error('boom');
    });
    await should(failing).be.rejectedWith('boom');
    const next = await subject.exclusive('claude', async () => 'next');

    // Assert
    should(next).equal('next');
  });

  it('should refuse the claim when the lock cannot be loaded here, saying why', async () => {
    // Arrange
    const { port } = await home();
    const subject = disk(port, {
      loadLock: () => {
        throw new Error('no libc');
      },
    });

    // Act
    const claiming = subject.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejectedWith('the conversation lease lock could not be loaded here (no libc)');
  });

  it('should say a lock that failed for a reason that is not an Error as text', async () => {
    // Arrange
    const { port } = await home();
    const subject = disk(port, {
      loadLock: () => {
        throw 'plain text';
      },
    });

    // Act
    const claiming = subject.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejectedWith(/could not be loaded here \(plain text\)/u);
  });

  it('should refuse a pool folder that is a link, so a lease can never be redirected', async () => {
    // Arrange
    const { port, tree, pool } = await home();
    const outside = await temp('fy-daemon-leases-redirect-');
    await mkdir(tree, { recursive: true });
    await symlink(outside, pool);
    const subject = disk(port);

    // Act
    const claiming = subject.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejectedWith(/is not a plain folder/u);
    should(await readdir(outside)).be.empty();
  });

  it('should refuse a lease tree that is a link, so the pool above it cannot be redirected either', async () => {
    // Arrange
    const { port, tree } = await home();
    const outside = await temp('fy-daemon-leases-redirect-');
    await mkdir(join(outside, 'claude'), { recursive: true });
    await mkdir(join(tree, '..'), { recursive: true });
    await symlink(outside, tree);
    const subject = disk(port);

    // Act
    const claiming = subject.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejectedWith(/is not a plain folder/u);
    should(await readdir(join(outside, 'claude'))).be.empty();
  });

  it('should refuse a lock name that is a link, never following it', async () => {
    // Arrange
    const { port, pool } = await home();
    const outside = await temp('fy-daemon-leases-redirect-');
    await writeFile(join(outside, 'target'), 'x');
    await mkdir(pool, { recursive: true });
    await symlink(join(outside, 'target'), join(pool, 'pool.lock'));
    const subject = disk(port);

    // Act
    const claiming = subject.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejected();
  });

  it('should refuse a lock name that is not a regular file', async () => {
    // Arrange
    const { port, pool } = await home();
    await mkdir(pool, { recursive: true });
    const made = Bun.spawnSync(['mkfifo', join(pool, 'pool.lock')]);
    should(made.exitCode).equal(0);
    const subject = disk(port);

    // Act
    const claiming = subject.exclusive('claude', async () => 'never');

    // Assert
    await should(claiming).be.rejectedWith('refusing the conversation lease lock: it is not a regular file');
  });
});

describe('flock', () => {
  it('should exclude a second open of the same file, even in one process, until the first is closed', async () => {
    // Arrange
    const folder = await temp('fy-daemon-flock-');
    const path = join(folder, 'lock');
    await writeFile(path, '');
    const lock: ConversationLeaseLock = loadConversationLeaseLock(process.platform);
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
    const lock = loadConversationLeaseLock(process.platform);

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

describe('the daemon and `fy history claim` over ONE set of lease files', () => {
  const S = parseSessionId('mw7bp88g-50e00159');
  const sessions = (status: string) => ({
    launchOf: () => ({ harness: 'claude' as const, runtime: 'claude-review' }),
    registryState: () => undefined,
    readState: async () => ({ status }),
  });

  it("should refuse the daemon's claim for a session while a person's terminal holds the conversation, and name that process", async () => {
    // Arrange — `fy history claim` in a terminal: this very process, through the CLI's disk
    const { port } = await home();
    const terminal = new ConversationLeaseStore(new StateLeaseDisk(port, processes), () => new Date());
    await terminal.claim(
      { harness: 'claude', conversation: CONVERSATION, holder: { pid: process.pid } },
      async () => 'unknown',
    );
    const daemon = new ConversationLeases(
      new ConversationLeaseStore(disk(port), () => new Date()),
      sessions('running'),
      process.pid + 1,
    );

    // Act
    const claiming = daemon.claim(S, ['/opt/fleet/bin/claude', '--resume', CONVERSATION]);

    // Assert
    await should(claiming).rejectedWith(ConversationLeaseHeldError);
    await claiming.catch((error: Error) => should(error.message).containEql(`running as process ${process.pid}`));
  });

  it("should make a terminal's claim refuse the conversation the daemon leased to a live session, and renew it for that session's own wrapper", async () => {
    // Arrange — the daemon leases C to S; the terminal side reads the same file
    const { port } = await home();
    const daemon = new ConversationLeases(
      new ConversationLeaseStore(disk(port), () => new Date()),
      sessions('running'),
      process.pid,
    );
    await daemon.claim(S, ['/opt/fleet/bin/claude', '--resume', CONVERSATION]);
    const terminal = new ConversationLeaseStore(new StateLeaseDisk(port, processes), () => new Date());

    // Act
    const person = await terminal.claim(
      { harness: 'claude', conversation: CONVERSATION, holder: { pid: process.pid } },
      async () => 'live',
    );
    const wrapper = await terminal.claim(
      { harness: 'claude', conversation: CONVERSATION, holder: { pid: process.pid, session: S } },
      async () => 'live',
    );

    // Assert
    should(person.kind).equal('held');
    should(wrapper).containDeep({ kind: 'claimed', decision: 'renew' });
  });

  it('should exclude the two programs from each other: a claim waits while the other side holds the pool lock', async () => {
    // Arrange
    const { port } = await home();
    const terminal = new StateLeaseDisk(port, processes);
    const daemon = disk(port, { waitMs: 40, pollMs: 5 });
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const holding = terminal.exclusive('claude', async () => await held);
    await Bun.sleep(30);

    // Act
    const waiting = daemon.exclusive('claude', async () => 'never');

    // Assert
    await should(waiting).be.rejectedWith(/stayed busy/u);
    release();
    await holding;
  });
});
