import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FleetApplyLock } from '../../src/adapters/apply-lock.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-fleet-lock-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

/** The old convenience shape, rebuilt on the acquire/release pair the provisioner now drives. */
async function held<T>(lock: FleetApplyLock, work: () => Promise<T>): Promise<T> {
  const token = await lock.acquire();
  try {
    return await work();
  } finally {
    await lock.release(token);
  }
}

const claimOf = (owner: number, token: string, at: number = Date.now()): string =>
  `${JSON.stringify({ owner, token, at })}\n`;

describe('FleetApplyLock', () => {
  it('should hold the fleet exclusively across separate lock objects', async () => {
    // Arrange — two objects are what a command-line apply and a daemon apply look like here.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const order: string[] = [];
    const first = new FleetApplyLock(lockPath, { pollMs: 1 });
    const second = new FleetApplyLock(lockPath, { pollMs: 1 });
    const work = (name: string) => async () => {
      order.push(`enter ${name}`);
      await settled();
      order.push(`exit ${name}`);
    };

    // Act
    await Promise.all([held(first, work('first')), held(second, work('second'))]);

    // Assert
    should(order[1]).equal(order[0]?.replace('enter', 'exit'));
    should(order[3]).equal(order[2]?.replace('enter', 'exit'));
  });

  it('should release the claim when the work throws', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });

    // Act
    const promise = held(subject, async () => {
      throw new Error('apply failed');
    });

    // Assert
    await should(promise).be.rejectedWith(/apply failed/u);
    should(await Bun.file(lockPath).exists()).be.false();
  });

  it('should create the fleet directory a first run does not have yet', async () => {
    // Arrange
    const parent = await temporaryDirectory();
    const lockPath = path.join(parent, 'fleet', '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });

    // Act
    const actual = await held(subject, async () => 'ran');

    // Assert
    should(actual).equal('ran');
  });

  it('should leave an abandoned claim in place and name it for recovery', async () => {
    // Arrange — taking it over automatically cannot be done atomically, so it is not attempted.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const abandoned = claimOf(424242, 'abandoned', 0);
    await writeFile(lockPath, abandoned);
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10, isOwnerAlive: () => false });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/owner 424242.*no longer running.*can be removed/su);
    should(await readFile(lockPath, 'utf8')).equal(abandoned);
  });

  it('should wait out a live owner however long its apply has been running', async () => {
    // Arrange — age alone is never a reason to take a lock; a large fleet legitimately takes time.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const ancient = claimOf(1, 'slow-but-healthy', 0);
    await writeFile(lockPath, ancient);
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10, isOwnerAlive: () => true });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/owner 1 at .*still running/su);
    should(await readFile(lockPath, 'utf8')).equal(ancient);
  });

  it('should never destroy a claim it cannot read', async () => {
    // Arrange — unreadable evidence proves nothing about whether an owner is still working.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await writeFile(lockPath, 'not json at all\n');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10 });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/claim could not be read/u);
    should(await readFile(lockPath, 'utf8')).equal('not json at all\n');
  });

  it('should never destroy a claim whose shape it does not recognise', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await writeFile(lockPath, '{"owner":"not-a-number"}\n');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10 });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/claim could not be read/u);
    should(await readFile(lockPath, 'utf8')).equal('{"owner":"not-a-number"}\n');
  });

  it('should refuse, and never destroy, a lock name that is occupied by a directory', async () => {
    // Arrange — a directory occupies the name, so no claim can ever be published there.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await mkdir(lockPath);
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10 });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert — nothing here ever takes a name over, whatever is sitting on it.
    await should(promise).be.rejectedWith(/claim could not be read/u);
    should((await lstat(lockPath)).isDirectory()).be.true();
  });

  it('should report residue when a superseded holder finds somebody else’s claim', async () => {
    // Arrange — the earlier version returned "no residue" here, which told a successful apply the
    // fleet was free while a claim sat on disk blocking every later one.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });
    const successor = claimOf(2, 'successor');

    // Act
    const token = await subject.acquire();
    await writeFile(lockPath, successor);
    const residue = await subject.release(token);

    // Assert
    should(residue).equal(lockPath);
    should(await readFile(lockPath, 'utf8')).equal(successor);
  });

  it('should clean up a fleet directory it created when the claim itself cannot be made', async () => {
    // Arrange — a name too long for the filesystem fails the publish for an operational reason
    // rather than contention, and it fails after this attempt has already created the directory.
    const parent = await temporaryDirectory();
    const fleet = path.join(parent, 'fleet');
    const lockPath = path.join(fleet, `${'n'.repeat(300)}.lock`);
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10 });

    // Act
    const promise = subject.acquire();

    // Assert — no token was returned, so nobody will ever release; the directory this attempt
    // brought into existence, and its private staged claim, both go back.
    await should(promise).be.rejected();
    should(await Bun.file(fleet).exists()).be.false();
    should(await readdir(parent)).deepEqual([]);
  });

  it('should keep a fleet directory that was already there when a claim cannot be made', async () => {
    // Arrange
    const parent = await temporaryDirectory();
    const fleet = path.join(parent, 'fleet');
    await mkdir(fleet);
    await writeFile(path.join(fleet, 'config.yaml'), 'agents: []\n');
    const subject = new FleetApplyLock(path.join(fleet, `${'n'.repeat(300)}.lock`), { pollMs: 1, waitMs: 10 });

    // Act
    const promise = subject.acquire();

    // Assert — cleanup only ever removes what this attempt created.
    await should(promise).be.rejected();
    should(await readFile(path.join(fleet, 'config.yaml'), 'utf8')).equal('agents: []\n');
  });

  it('should not let a superseded holder unlink its successor', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });
    const successor = claimOf(2, 'successor');

    // Act — the holder's claim is replaced while it works, so its release must be a no-op.
    await held(subject, async () => {
      await writeFile(lockPath, successor);
    });

    // Assert
    should(await readFile(lockPath, 'utf8')).equal(successor);
  });

  it('should clear its own claim even when the claim has become unreadable', async () => {
    // Arrange — nothing ever takes a lock over, so while this holder runs no other claim can
    // legitimately occupy the name. Leaving an unreadable one would block every future apply.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });

    // Act
    const token = await subject.acquire();
    await writeFile(lockPath, 'no longer parseable\n');
    const residue = await subject.release(token);

    // Assert
    should(residue).equal(undefined);
    should(await Bun.file(lockPath).exists()).be.false();
  });

  it('should report a claim it could not clear instead of throwing over the work', async () => {
    // Arrange — a release that threw from a finally would replace the apply's own outcome, so a
    // committed fleet would be reported as an unrelated filesystem error.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });

    // Act
    const token = await subject.acquire();
    await rm(lockPath, { force: true });
    await mkdir(path.join(lockPath, 'occupied'), { recursive: true });
    const residue = await subject.release(token);

    // Assert
    should(residue).equal(lockPath);
  });

  it('should read liveness from the running task when no check is injected', async () => {
    // Arrange — this task's own leaked claim, one that cannot exist, and one it may not signal.
    const root = await temporaryDirectory();
    const cases = [
      { owner: globalThis.process.pid, expected: /this very task.*can be removed/su },
      { owner: 424242, expected: /no longer running/u },
      { owner: 1, expected: /running/u },
    ];

    for (const { owner, expected } of cases) {
      const lockPath = path.join(root, `${owner}.lock`);
      await writeFile(lockPath, claimOf(owner, `held-by-${owner}`));
      const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 5 });

      // Act
      const promise = held(subject, async () => 'ran');

      // Assert
      await should(promise).be.rejectedWith(expected);
    }
  });

  it('should leave no staged claim behind whether it wins or loses the name', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const first = new FleetApplyLock(lockPath, { pollMs: 1 });
    const second = new FleetApplyLock(lockPath, { pollMs: 1 });

    // Act
    await Promise.all([held(first, settled), held(second, settled)]);

    // Assert
    should(await readdir(root)).deepEqual([]);
  });
});
