import { Database } from 'bun:sqlite';
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import {
  FileConversationLeaseStore,
  HostProcessStarts,
  type ProcessStartSource,
} from '../../src/adapters/file-shared-history.ts';
import type { ConversationLeaseClaim } from '../../src/lib/shared-history.ts';

const CONVERSATION = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
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
    const claiming = store.claim({ harness: 'claude', conversation: '../escape', holder: { pid: 1 } }, unknown);

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
      { harness: 'claude', conversation: 'another-conversation', holder: { pid: 10, session: 's-2' } },
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
    await mkdir(path.dirname(leaseFile(fleet)), { recursive: true });
    const other = new Database(path.join(path.dirname(leaseFile(fleet)), '.lock'), { create: true });
    other.exec('PRAGMA journal_mode = MEMORY');
    other.exec('BEGIN EXCLUSIVE');
    // The other claimant lets go while the store is polling. The claim's own wait is 5 s, so the order
    // of the two cannot change the outcome.
    setTimeout(() => {
      other.exec('ROLLBACK');
      other.close();
    }, 40);

    // Act
    const outcome = await store.claim(claim({ pid: 10 }), unknown);

    // Assert
    should(outcome.kind).equal('claimed');
  });

  it('should say the store stayed busy when another claimant never finishes', async () => {
    // Arrange
    const fleet = await temporaryDirectory();
    await mkdir(path.dirname(leaseFile(fleet)), { recursive: true });
    const other = new Database(path.join(path.dirname(leaseFile(fleet)), '.lock'), { create: true });
    other.exec('PRAGMA journal_mode = MEMORY');
    other.exec('BEGIN EXCLUSIVE');
    const store = new FileConversationLeaseStore(fleet, new FakeStarts(new Map()), { waitMs: 30, pollMs: 5 });

    // Act
    const claiming = store.claim(claim({ pid: 10 }), unknown);

    // Assert
    try {
      await should(claiming).be.rejectedWith(/stayed busy/u);
    } finally {
      other.exec('ROLLBACK');
      other.close();
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
