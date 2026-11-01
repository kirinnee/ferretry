import { afterEach, describe, it, spyOn } from 'bun:test';
import { dlopen, FFIType } from 'bun:ffi';
import * as fsSync from 'node:fs';
import { closeSync, constants, openSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import {
  FileConversationLeaseStore,
  fencedConversationLeaseStore,
  HostProcessStarts,
  type ProcessStartSource,
} from '../../src/adapters/file-shared-history.ts';
import { FILE_OPENINGS, O_CLOEXEC } from '../../src/adapters/descriptor-calls.ts';
import { LIBC } from '../../src/adapters/directory-syscalls.ts';
import { flockRefusal, loadedOnce, loadFileLock, processFileLock } from '../../src/adapters/link-syscall.ts';
import { NodeGuardDisk } from '../../src/adapters/node-guard-disk.ts';
import {
  type ConversationId,
  ConversationIdSchema,
  type ConversationLeaseClaim,
} from '../../src/lib/shared-history.ts';
import type { FileOpening, GuardDirectoryHandle } from '../../src/lib/state-home-guard.ts';

const CONVERSATION = ConversationIdSchema.parse('0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21');
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-conversation-lease-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** Pids with a fixed start time each; anything else reads as gone. */
class FakeStarts implements ProcessStartSource {
  constructor(readonly starts: Map<number, number>) {}
  async startOf(pid: number): Promise<number | undefined> {
    return this.starts.get(pid);
  }
}

function claim(
  holder: ConversationLeaseClaim['holder'],
  harness: 'claude' | 'codex' = 'claude',
): ConversationLeaseClaim {
  return { harness, conversation: CONVERSATION, holder };
}

const unknown = async (): Promise<'unknown'> => 'unknown';

function leaseFile(fleet: string, harness = 'claude'): string {
  return path.join(fleet, 'shared', harness, '.leases', CONVERSATION);
}

/** Another claimant holding the pool's lock from its own open of the lock file; the returned call lets go. */
async function holdLock(fleet: string): Promise<() => void> {
  const lock = path.join(path.dirname(leaseFile(fleet)), '.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  const descriptor = openSync(lock, constants.O_RDONLY | constants.O_CREAT, 0o600);
  if (!loadFileLock().tryLock(descriptor)) throw new Error('the lock was already held');
  return () => closeSync(descriptor);
}

describe('FileConversationLeaseStore', () => {
  it('should write a private lease naming the holder and its start time', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map([[10, 5]])), {
      now: () => new Date('2026-10-13T14:02:09.000Z'),
    });

    // Act
    const outcome = await store.claim(claim({ pid: 10, session: 's-1', runtime: 'claude-review' }), unknown);

    // Assert
    const expected = {
      v: 1,
      harness: 'claude',
      conversation: CONVERSATION,
      holder: { pid: 10, session: 's-1', runtime: 'claude-review', start: 5 },
      since: '2026-10-13T14:02:09.000Z',
    };
    should(outcome).eql({ kind: 'claimed', decision: 'create', lease: expected });
    should(JSON.parse(await readFile(leaseFile(fleet), 'utf8'))).eql(expected);
    should((await stat(leaseFile(fleet))).mode & 0o777).equal(0o600);
  });

  it('should refuse a second writer and keep the first lease', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    const store = new FileConversationLeaseStore(
      fleet,
      new FakeStarts(
        new Map([
          [10, 5],
          [11, 6],
        ]),
      ),
    );
    const first = await store.claim(claim({ pid: 10 }), unknown);

    // Act
    const second = await store.claim(claim({ pid: 11 }), unknown);

    // Assert
    should(first.kind).equal('claimed');
    should(second).eql({ kind: 'held', lease: first.lease });
  });

  it('should take over a lease whose holder has exited, with no person involved', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    const starts = new Map([
      [10, 5],
      [11, 6],
    ]);
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(starts));
    await store.claim(claim({ pid: 10 }), unknown);
    starts.delete(10);

    // Act
    const outcome = await store.claim(claim({ pid: 11 }), unknown);

    // Assert
    should(outcome).match({ kind: 'claimed', decision: 'take-over', lease: { holder: { pid: 11, start: 6 } } });
  });

  it('should keep the first claim time when the same session renews with its harness pid', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    const times = ['2026-10-13T14:02:00.000Z', '2026-10-13T15:00:00.000Z'];
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map([[10, 5]])), {
      now: () => new Date(times.shift() ?? ''),
    });
    await store.claim(claim({ pid: 10, session: 's-1' }), unknown);

    // Act
    const outcome = await store.claim(claim({ pid: 12, session: 's-1' }), unknown);

    // Assert
    should(outcome).match({
      kind: 'claimed',
      decision: 'renew',
      lease: { holder: { pid: 12, session: 's-1' }, since: '2026-10-13T14:02:00.000Z' },
    });
    should(outcome.lease.holder).not.have.property('start');
  });

  it('should ask the caller whether the holding session is still writing', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map([[10, 5]])));
    await store.claim(claim({ pid: 10, session: 's-1' }), unknown);
    const asked: string[] = [];

    // Act
    const outcome = await store.claim(claim({ pid: 10, session: 's-2' }), async session => {
      asked.push(session);
      return 'over';
    });

    // Assert
    should(asked).eql(['s-1']);
    should(outcome).match({ kind: 'claimed', decision: 'take-over', lease: { holder: { session: 's-2' } } });
  });

  it('should create over a lease file it cannot read as a lease', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    await mkdir(path.dirname(leaseFile(fleet)), { recursive: true });
    await writeFile(leaseFile(fleet), '{not json');
    await writeFile(`${leaseFile(fleet)}x`, JSON.stringify({ v: 2 }));
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()));

    // Act
    const outcome = await store.claim(claim({ pid: 10 }), unknown);

    // Assert
    should(outcome).match({ kind: 'claimed', decision: 'create' });
  });

  it('should fail rather than guess when the lease path cannot be read', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    await mkdir(leaseFile(fleet), { recursive: true });
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()));

    // Act
    const claiming = store.claim(claim({ pid: 10 }), unknown);

    // Assert
    await should(claiming).be.rejected();
  });

  it('should refuse a conversation id that could name another path', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()));

    // Act
    // A caller that is not typed (JavaScript, a cast) is parsed again at the store.
    const claiming = store.claim(
      { harness: 'claude', conversation: '../escape' as ConversationId, holder: { pid: 1 } },
      unknown,
    );

    // Assert
    await should(claiming).be.rejected();
  });

  it('should release only the leases one session holds, in every pool', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map([[10, 5]])));
    await store.claim(claim({ pid: 10, session: 's-1' }, 'claude'), unknown);
    await store.claim(claim({ pid: 10, session: 's-1' }, 'codex'), unknown);
    await store.claim(
      {
        harness: 'claude',
        conversation: ConversationIdSchema.parse('another-conversation'),
        holder: { pid: 10, session: 's-2' },
      },
      unknown,
    );

    // Act
    const released = await store.releaseSession('s-1');

    // Assert
    should(released).eql([CONVERSATION, CONVERSATION]);
    should((await readdir(path.join(fleet, 'shared', 'claude', '.leases'))).sort()).eql([
      '.lock',
      'another-conversation',
    ]);
    should(await readdir(path.join(fleet, 'shared', 'codex', '.leases'))).eql(['.lock']);
  });

  it('should release nothing when no pool has been created yet', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()));

    // Act
    const released = await store.releaseSession('s-1');

    // Assert
    should(released).be.empty();
  });

  it('should fail a release whose pool cannot be listed', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    await mkdir(path.join(fleet, 'shared', 'claude'), { recursive: true });
    await writeFile(path.join(fleet, 'shared', 'claude', '.leases'), 'not a directory');
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()));

    // Act
    const releasing = store.releaseSession('s-1');

    // Assert
    await should(releasing).be.rejected();
  });

  it('should wait for another claimant to finish, then claim', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { pollMs: 5 });
    await store.releaseSession('nobody');
    const letGo = await holdLock(fleet);
    // The other claimant lets go while the store is polling. The claim's own wait is 5 s, so the order
    // of the two cannot change the outcome.
    setTimeout(letGo, 40);

    // Act
    const outcome = await store.claim(claim({ pid: 10 }), unknown);

    // Assert
    should(outcome.kind).equal('claimed');
  });

  it('should say the store stayed busy when another claimant never finishes', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    const letGo = await holdLock(fleet);
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { waitMs: 30, pollMs: 5 });

    // Act
    const claiming = store.claim(claim({ pid: 10 }), unknown);

    // Assert
    try {
      await should(claiming).be.rejectedWith(/stayed busy/u);
      should(await readdir(path.dirname(leaseFile(fleet)))).eql(['.lock']);
    } finally {
      letGo();
    }
  });
});

describe('HostProcessStarts', () => {
  it('should read a running pid on Linux and nothing for a pid that has exited', async () => {
    // Arrange
    const starts = new HostProcessStarts('linux');
    const child = Bun.spawn(['true']);
    await child.exited;

    // Act
    const own = await starts.startOf(process.pid);
    const gone = await starts.startOf(child.pid);
    const invalid = await starts.startOf(0);

    // Assert
    should(own).be.a.Number().and.be.above(0);
    should(gone).be.undefined();
    should(invalid).be.undefined();
  });

  it('should read field 22 past a command name holding spaces and parentheses', async () => {
    // Arrange
    const proc = await temporaryDirectory();
    await mkdir(path.join(proc, '7'));
    await mkdir(path.join(proc, '8'));
    await writeFile(
      path.join(proc, '7', 'stat'),
      `7 (a b) c) S ${Array.from({ length: 18 }, () => '0').join(' ')} 4321 rest`,
    );
    await writeFile(path.join(proc, '8', 'stat'), '8 (short) S 1');
    const starts = new HostProcessStarts('linux', proc);

    // Act
    const read = [await starts.startOf(7), await starts.startOf(8)];

    // Assert
    should(read).eql([4321, undefined]);
  });

  it('should read ps elsewhere, in UTC, and nothing when ps fails or says nothing usable', async () => {
    // Arrange
    const bin = await temporaryDirectory();
    const ps = path.join(bin, 'ps');
    await writeFile(
      ps,
      '#!/bin/sh\ncase "$4" in\n  1) echo "Sat Sep  6 18:48:09 2026" ;;\n  2) echo "garbage" ;;\n  *) exit 1 ;;\nesac\n',
    );
    await chmod(ps, 0o755);
    const starts = new HostProcessStarts('darwin', '/proc', ps);

    // Act
    const read = [await starts.startOf(1), await starts.startOf(2), await starts.startOf(3)];

    // Assert
    should(read).eql([Date.UTC(2026, 8, 6, 18, 48, 9) / 1000, undefined, undefined]);
  });
});

describe('FileConversationLeaseStore through checked folder handles, with the state home fenced', () => {
  /** A fleet inside a state home holding its vault key, the way the daemon lays it out. */
  const world = async () => {
    const machine = await realpath(await temporaryDirectory());
    const home = path.join(machine, '.ferretry');
    const fleet = path.join(home, 'fleet');
    await mkdir(path.join(home, 'state'), { recursive: true });
    await mkdir(path.join(home, 'config'), { recursive: true });
    await mkdir(fleet, { recursive: true });
    await writeFile(path.join(home, 'state', 'secrets.key'), 'vault-key\n');
    await writeFile(path.join(home, 'api-token'), 'token\n');
    const fence = {
      homes: [home, path.join(home, 'state'), path.join(home, 'config')],
      open: [],
      pinned: [path.join(home, 'api-token')],
    };
    return { home, fleet, fence };
  };
  /** The state home's own names, to prove a lease step changed none of them. */
  const homeNames = async (home: string): Promise<readonly string[]> =>
    [...(await readdir(home)), ...(await readdir(path.join(home, 'state')))].toSorted();

  it.each([
    ['through descriptor paths (Linux)', undefined],
    ['through descriptor calls (macOS)', 'calls' as const],
  ])('should claim, refuse a second writer, and release a lease %s', async (_label, reach) => {
    // Arrange — the store as the daemon and `fy history claim` build it, fenced by the home that holds the fleet.
    const { home, fleet } = await world();
    const disk = reach === undefined ? undefined : new NodeGuardDisk(reach);
    const store = fencedConversationLeaseStore(
      { stateHome: home, fleetDirectory: fleet },
      new FakeStarts(
        new Map([
          [10, 5],
          [11, 6],
        ]),
      ),
      disk === undefined ? {} : { disk },
    );
    const before = await homeNames(home);

    // Act
    const first = await store.claim(claim({ pid: 10, session: 's-1' }), unknown);
    const second = await store.claim(claim({ pid: 11, session: 's-2' }), async () => 'live');
    const released = await store.releaseSession('s-1');

    // Assert — a lease was written, held against another session, and taken back; nothing in the home changed.
    should(first).match({ kind: 'claimed', decision: 'create' });
    should(second).match({ kind: 'held', lease: { holder: { session: 's-1' } } });
    should(released).eql([CONVERSATION]);
    should(await readdir(path.dirname(leaseFile(fleet)))).eql(['.lock']);
    should(await homeNames(home)).eql(before);
    should(await readFile(path.join(home, 'api-token'), 'utf8')).equal('token\n');
  });

  it.each([
    ['through descriptor paths (Linux)', undefined],
    ['through descriptor calls (macOS)', 'calls' as const],
  ])('should make no change, and read no lease, by path %s', async (_label, reach) => {
    // Arrange — every call that changes the disk, and every read of a lease, is recorded with the path it was handed.
    // A step made through its folder hands a descriptor path (`/proc/self/fd/N/…`) or, inside a descriptor bracket,
    // one entry's name.
    const { home, fleet, fence } = await world();
    const disk = reach === undefined ? undefined : new NodeGuardDisk(reach);
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map([[10, 5]])), {
      fence,
      ...(disk === undefined ? {} : { disk }),
    });
    const byPath: string[] = [];
    const watch = (at: unknown): void => {
      if (typeof at === 'string' && at.startsWith('/') && !at.startsWith('/proc/self/fd/')) byPath.push(at);
    };
    // A read is judged only inside the state home, and not of a home itself: the guard opens each home by path to start
    // its no-follow walk there, and reads `/etc/group` by path, by design.
    const watchRead = (at: unknown): void => {
      if (typeof at === 'string' && at.startsWith(home) && !fence.homes.includes(at)) byPath.push(at);
    };
    const writes = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_TRUNC;
    const READS = new Set(['readFile', 'readFileSync', 'readdir', 'readdirSync', 'open']);
    /** Which of a call's arguments are paths it changes. */
    const changed = (name: string, args: readonly unknown[]): readonly unknown[] => {
      if (READS.has(name)) {
        watchRead(args[0]);
        return [];
      }
      if (name === 'openSync') {
        if (typeof args[1] === 'number' && (args[1] & writes) !== 0) return [args[0]];
        // A lease or the lock opened to read: by a descriptor path, or by one name inside the bracket.
        watchRead(args[0]);
        return [];
      }
      return args.slice(0, 2);
    };
    const spies: { mockRestore(): void }[] = [];
    const spyEach = (module: object, names: readonly string[]): void => {
      for (const name of names) {
        const original = Reflect.get(module, name) as (...args: unknown[]) => unknown;
        spies.push(
          spyOn(module as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(
            (...args: unknown[]) => {
              for (const argument of changed(name, args)) watch(argument);
              return original(...args);
            },
          ),
        );
      }
    };
    spyEach(fs, ['rename', 'link', 'unlink', 'rm', 'rmdir', 'mkdir', 'writeFile', 'open', 'readFile', 'readdir']);
    spyEach(fsSync, [
      'renameSync',
      'linkSync',
      'unlinkSync',
      'rmSync',
      'rmdirSync',
      'mkdirSync',
      'writeFileSync',
      'openSync',
      'readFileSync',
      'readdirSync',
    ]);

    try {
      // Act — a claim that makes the pool's folders, one that renews over the lease, and a release.
      await store.claim(claim({ pid: 10, session: 's-1' }), unknown);
      await store.claim(claim({ pid: 10, session: 's-1' }), unknown);
      const released = await store.releaseSession('s-1');

      // Assert — it worked, and not one change or lease read was made by a path a swapped folder could redirect.
      should(released).eql([CONVERSATION]);
      should(byPath).deepEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('should refuse the lease, writing nothing, where its folder cannot be reached through its descriptor', async () => {
    // Arrange — a disk reached by path only (the C calls could not be loaded).
    const { fleet, fence } = await world();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), {
      fence,
      disk: new NodeGuardDisk(false),
    });

    // Act + Assert
    await should(store.claim(claim({ pid: 10 }), unknown)).be.rejectedWith({
      name: 'ConversationLeaseUnavailableError',
      message: /cannot be reached through its descriptor here/u,
    });
    should(await readdir(fleet)).eql([]);
  });

  it('should refuse a release, removing nothing, where the lease folder cannot be reached through its descriptor', async () => {
    // Arrange — a lease written while reach was there; the daemon now runs where it is not.
    const { fleet, fence } = await world();
    await new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { fence }).claim(
      claim({ pid: 10, session: 's-1' }),
      unknown,
    );
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), {
      fence,
      disk: new NodeGuardDisk(false),
    });

    // Act + Assert
    await should(store.releaseSession('s-1')).be.rejectedWith({ name: 'ConversationLeaseUnavailableError' });
    should((await readdir(path.dirname(leaseFile(fleet)))).toSorted()).eql(['.lock', CONVERSATION]);
  });

  it('should refuse the lease on a Linux host that has no /proc/self/fd', async () => {
    // Arrange
    const { fleet, fence } = await world();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), {
      fence,
      disk: new NodeGuardDisk(true, '/etc/group', path.join(fleet, 'no-proc')),
    });

    // Act + Assert
    await should(store.claim(claim({ pid: 10 }), unknown)).be.rejectedWith({
      name: 'ConversationLeaseUnavailableError',
      message: /this host has no \/proc\/self\/fd/u,
    });
    should(await readdir(fleet)).eql([]);
  });

  it('should refuse the lease, writing none, where the lock it is decided under cannot be loaded', async () => {
    // Arrange
    const { fleet, fence } = await world();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), {
      fence,
      loadLock: () => {
        throw new Error('no flock in this C library');
      },
    });

    // Act + Assert
    await should(store.claim(claim({ pid: 10 }), unknown)).be.rejectedWith({
      name: 'ConversationLeaseUnavailableError',
      message: /the lock it is decided under could not be loaded here \(no flock in this C library\)/u,
    });
    should(await readdir(path.dirname(leaseFile(fleet)))).eql([]);
  });

  it('should refuse a lock that is not a regular file', async () => {
    // Arrange — a pipe where the lock must be: it opens without blocking, and is refused once open.
    const { fleet, fence } = await world();
    await mkdir(path.dirname(leaseFile(fleet)), { recursive: true });
    should(Bun.spawnSync(['mkfifo', path.join(path.dirname(leaseFile(fleet)), '.lock')]).exitCode).equal(0);
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { fence });

    // Act + Assert
    await should(store.claim(claim({ pid: 10 }), unknown)).be.rejectedWith(/lock .* is not a regular file/u);
    should(await readdir(path.dirname(leaseFile(fleet)))).eql(['.lock']);
  });

  it('should fail rather than guess when the lock cannot be opened, or cannot be made', async () => {
    // Arrange — a lock this user may not read, and a lease folder this user may not write a lock into.
    const { fleet, fence } = await world();
    const leases = path.dirname(leaseFile(fleet));
    await mkdir(leases, { recursive: true });
    await writeFile(path.join(leases, '.lock'), '', { mode: 0o000 });
    const codex = path.dirname(leaseFile(fleet, 'codex'));
    await mkdir(codex, { recursive: true });
    await chmod(codex, 0o500);
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { fence });

    // Act + Assert
    try {
      await should(store.claim(claim({ pid: 10 }), unknown)).be.rejectedWith({ code: 'EACCES' });
      await should(store.claim(claim({ pid: 10 }, 'codex'), unknown)).be.rejectedWith({ code: 'EACCES' });
    } finally {
      await chmod(codex, 0o700);
    }
  });

  // The two seams below hook the disk's by-path `openFile`, which descriptor paths use: Linux only.
  it.skipIf(process.platform !== 'linux')(
    'should open the lock another claimant made between its two opens',
    async () => {
      // Arrange — the first look finds no lock; by the exclusive make, another claimant has made it.
      const { fleet, fence } = await world();
      let raced = false;
      class RacingDisk extends NodeGuardDisk {
        override async openFile(at: string, how: FileOpening, mode: number): Promise<number> {
          if (!raced && how === 'read' && at.endsWith('/.lock')) {
            raced = true;
            await super.openFile(at, 'new', 0o600).then(closeSync);
            throw Object.assign(new Error(`ENOENT: ${at}`), { code: 'ENOENT' });
          }
          return await super.openFile(at, how, mode);
        }
      }
      const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { fence, disk: new RacingDisk() });

      // Act
      const outcome = await store.claim(claim({ pid: 10 }), unknown);

      // Assert
      should(raced).be.true();
      should(outcome).match({ kind: 'claimed', decision: 'create' });
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'should give up on a lock that keeps appearing and disappearing',
    async () => {
      // Arrange — every look finds none, and every make finds one.
      const { fleet, fence } = await world();
      class FlickeringDisk extends NodeGuardDisk {
        override async openFile(at: string, how: FileOpening, mode: number): Promise<number> {
          if (!at.endsWith('/.lock')) return await super.openFile(at, how, mode);
          const code = how === 'read' ? 'ENOENT' : 'EEXIST';
          throw Object.assign(new Error(`${code}: ${at}`), { code });
        }
      }
      const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), {
        fence,
        disk: new FlickeringDisk(),
      });

      // Act + Assert
      await should(store.claim(claim({ pid: 10 }), unknown)).be.rejectedWith(
        /kept appearing and disappearing while it was opened/u,
      );
    },
  );

  it('should fail rather than guess when a lease cannot be opened', async () => {
    // Arrange — a lease this user may not read.
    const { fleet, fence } = await world();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { fence });
    await store.claim(claim({ pid: 10, session: 's-1' }), unknown);
    await chmod(leaseFile(fleet), 0o000);

    // Act + Assert
    await should(store.claim(claim({ pid: 11, session: 's-2' }), unknown)).be.rejectedWith({ code: 'EACCES' });
  });

  it('should read a lease file larger than any lease as none, never reading it whole', async () => {
    // Arrange — a sparse 1 GiB file under the conversation's name, which costs its writer nothing.
    const { fleet, fence } = await world();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { fence });
    await store.claim(claim({ pid: 10, session: 's-1' }), unknown);
    await fs.truncate(leaseFile(fleet), 1024 * 1024 * 1024);
    const reads: number[] = [];
    const original = Reflect.get(fsSync, 'readSync') as (...args: unknown[]) => number;
    const spy = spyOn(
      fsSync as unknown as Record<string, (...args: unknown[]) => unknown>,
      'readSync',
    ).mockImplementation((...args: unknown[]) => {
      const read = original(...args);
      reads.push(read);
      return read;
    });

    try {
      // Act — a release reads it as no lease and leaves it; a claim then creates over it.
      const released = await store.releaseSession('s-1');
      const claimed = await store.claim(claim({ pid: 10, session: 's-2' }), unknown);

      // Assert
      should(released).eql([]);
      should(claimed).match({ kind: 'claimed', decision: 'create' });
      should(Math.max(...reads)).be.belowOrEqual(64 * 1024 + 1);
      should((await stat(leaseFile(fleet))).size).be.below(1024);
    } finally {
      spy.mockRestore();
    }
  });

  // Hooks the disk's by-path `openDirectory`, which descriptor paths use: Linux only.
  it.skipIf(process.platform !== 'linux')(
    'should close every folder it opened when making the lease folder fails',
    async () => {
      // Arrange — a disk whose folders cannot be synced, counting every folder it opens and closes.
      const { fleet, fence } = await world();
      let opened = 0;
      let closed = 0;
      class UnsyncedDisk extends NodeGuardDisk {
        override async openDirectory(at: string): Promise<GuardDirectoryHandle> {
          const handle = await super.openDirectory(at);
          opened += 1;
          return {
            ...handle,
            sync: async () => {
              throw Object.assign(new Error(`EIO: ${at}`), { code: 'EIO' });
            },
            close: async () => {
              closed += 1;
              await handle.close();
            },
          };
        }
      }
      const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), {
        fence,
        disk: new UnsyncedDisk(),
      });

      // Act + Assert — the first folder it makes cannot be made durable; nothing it opened is left open.
      await should(store.claim(claim({ pid: 10 }), unknown)).be.rejectedWith({ code: 'EIO' });
      should(opened).be.above(0);
      should(closed).equal(opened);
    },
  );

  it.skipIf(process.platform !== 'linux')('should hold its lock on a descriptor no child inherits', async () => {
    // Arrange — the lock's open flags, as the kernel reports them while the store holds it.
    const { fleet, fence } = await world();
    const flags: number[] = [];
    class LookingDisk extends NodeGuardDisk {
      override async openFile(at: string, how: FileOpening, mode: number): Promise<number> {
        const descriptor = await super.openFile(at, how, mode);
        if (at.endsWith('/.lock')) {
          const fdinfo = fsSync.readFileSync(`/proc/self/fdinfo/${String(descriptor)}`, 'utf8');
          flags.push(Number.parseInt(/^flags:\s+(\d+)/mu.exec(fdinfo)?.[1] ?? '0', 8));
        }
        return descriptor;
      }
    }
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { fence, disk: new LookingDisk() });

    // Act
    await store.claim(claim({ pid: 10 }), unknown);

    // Assert — O_CLOEXEC, 0o2000000 on Linux.
    should(flags).not.be.empty();
    for (const flag of flags) should(flag & 0o2000000).equal(0o2000000);
  });

  it('should release past an entry it cannot read as a lease, leaving it', async () => {
    // Arrange — a folder under a conversation id's name, beside a lease the session holds.
    const { fleet, fence } = await world();
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { fence });
    await store.claim(claim({ pid: 10, session: 's-1' }), unknown);
    await mkdir(path.join(path.dirname(leaseFile(fleet)), 'ffff0000'));

    // Act
    const released = await store.releaseSession('s-1');

    // Assert
    should(released).eql([CONVERSATION]);
    should((await readdir(path.dirname(leaseFile(fleet)))).toSorted()).eql(['.lock', 'ffff0000']);
  });
});

describe('the descriptors a folder step opens', () => {
  /** `fcntl(F_GETFD)` and a raw `open` — both constants are 1 on Linux and macOS, and `open` is given no mode. */
  const libc = () =>
    dlopen(LIBC, {
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });

  it("should name this kernel's close-on-exec flag", async () => {
    // Arrange — opened by the C library itself, so the runtime cannot add the flag on its own.
    const file = path.join(await temporaryDirectory(), 'file');
    await writeFile(file, '');
    const { symbols, close } = libc();
    const name = new TextEncoder().encode(`${file}\0`);
    const plain = symbols.open(name, constants.O_RDONLY);
    const closing = symbols.open(name, constants.O_RDONLY | O_CLOEXEC);

    try {
      // Act + Assert
      should(symbols.fcntl(plain, 1, 0) & 1).equal(0);
      should(symbols.fcntl(closing, 1, 0) & 1).equal(1);
    } finally {
      closeSync(plain);
      closeSync(closing);
      close();
    }
  });

  it.each(Object.keys(FILE_OPENINGS) as FileOpening[])('should open %s close-on-exec', async how => {
    // Arrange — the descriptor-flag read (`fcntl(F_GETFD)`; both constants are 1 on Linux and macOS).
    const directory = await temporaryDirectory();
    const file = path.join(directory, 'file');
    if (how !== 'new') await writeFile(file, '');
    const { symbols, close } = libc();
    const descriptor = openSync(file, FILE_OPENINGS[how], 0o600);

    try {
      // Act
      const flags = symbols.fcntl(descriptor, 1, 0);

      // Assert — asked for, whatever this runtime adds on its own, and held.
      should(FILE_OPENINGS[how] & O_CLOEXEC).equal(O_CLOEXEC);
      should(flags & 1).equal(1);
    } finally {
      closeSync(descriptor);
      close();
    }
  });
});

describe('the lease lock (flock)', () => {
  it('should be loaded once for the process', () => {
    // Act + Assert
    should(processFileLock()).equal(processFileLock());
  });

  it('should call a loader once, and answer its value or its failure ever after', () => {
    // Arrange
    let calls = 0;
    const value = loadedOnce(() => {
      calls += 1;
      return { lock: calls };
    });
    let failures = 0;
    const failure = new Error('no flock here');
    const failing = loadedOnce((): never => {
      failures += 1;
      throw failure;
    });

    // Act
    const first = value();
    const second = value();
    const thrown = [0, 1].map(() => {
      try {
        failing();
        return undefined;
      } catch (error) {
        return error;
      }
    });

    // Assert
    should(first).equal(second);
    should(calls).equal(1);
    should(thrown).eql([failure, failure]);
    should(failures).equal(1);
  });

  it('should let one holder at a time hold it, and the next once the first lets go', async () => {
    // Arrange — two opens of one lock file, as two claimants make.
    const lock = path.join(await temporaryDirectory(), '.lock');
    await writeFile(lock, '');
    const locks = loadFileLock();
    const first = openSync(lock, constants.O_RDONLY);
    const second = openSync(lock, constants.O_RDONLY);

    try {
      // Act + Assert
      should(locks.tryLock(first)).be.true();
      should(locks.tryLock(second)).be.false();
      closeSync(first);
      should(locks.tryLock(second)).be.true();
    } finally {
      closeSync(second);
    }
  });

  it('should be let go when its holder dies', async () => {
    // Arrange — another process takes the lock and is killed while it holds it.
    const directory = await temporaryDirectory();
    const lock = path.join(directory, '.lock');
    await writeFile(lock, '');
    const holder = path.join(directory, 'holder.ts');
    await writeFile(
      holder,
      `import { openSync } from 'node:fs';
import { loadFileLock } from ${JSON.stringify(path.resolve(import.meta.dir, '../../src/adapters/link-syscall.ts'))};
if (!loadFileLock().tryLock(openSync(${JSON.stringify(lock)}, 'r'))) process.exit(3);
console.log('held');
setInterval(() => undefined, 1000);
`,
    );
    const child = Bun.spawn([process.execPath, holder], { stdout: 'pipe', stderr: 'inherit' });
    const reader = child.stdout.getReader();
    should(new TextDecoder().decode((await reader.read()).value)).startWith('held');
    const mine = openSync(lock, constants.O_RDONLY);

    try {
      // Act
      const whileAlive = loadFileLock().tryLock(mine);
      child.kill('SIGKILL');
      await child.exited;
      const afterDeath = loadFileLock().tryLock(mine);

      // Assert
      should(whileAlive).be.false();
      should(afterDeath).be.true();
    } finally {
      closeSync(mine);
    }
  });

  it('should throw with the errno for a descriptor it cannot lock', async () => {
    // Arrange
    const closed = openSync(await temporaryDirectory(), constants.O_RDONLY);
    closeSync(closed);

    // Act + Assert
    should(() => loadFileLock().tryLock(closed)).throw({ code: 'EBADF' });
  });

  it('should ask again after a signal, report one held by another, and throw anything else', () => {
    // Act + Assert
    should(flockRefusal(osConstants.errno.EINTR, 5)).equal('again');
    should(flockRefusal(osConstants.errno.EWOULDBLOCK, 5)).equal('held');
    should(() => flockRefusal(osConstants.errno.ENOLCK, 5)).throw({ code: 'ENOLCK', message: /flock 5/u });
    should(() => flockRefusal(99_999, 5)).throw({ code: 'errno 99999' });
  });
});
