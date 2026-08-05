import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    await Promise.all([first.run(work('first')), second.run(work('second'))]);

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
    const promise = subject.run(async () => {
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
    const actual = await subject.run(async () => 'ran');

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
    const promise = subject.run(async () => 'ran');

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
    const promise = subject.run(async () => 'ran');

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
    const promise = subject.run(async () => 'ran');

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
    const promise = subject.run(async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/claim could not be read/u);
    should(await readFile(lockPath, 'utf8')).equal('{"owner":"not-a-number"}\n');
  });

  it('should report the reason when the lock name can never be created', async () => {
    // Arrange — a directory occupies the name, so no claim can ever be published there.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await mkdir(lockPath);
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10 });

    // Act
    const promise = subject.run(async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/claim could not be read.*EEXIST/su);
  });

  it('should not let a superseded holder unlink its successor', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });
    const successor = claimOf(2, 'successor');

    // Act — the holder's claim is replaced while it works, so its release must be a no-op.
    await subject.run(async () => {
      await writeFile(lockPath, successor);
    });

    // Assert
    should(await readFile(lockPath, 'utf8')).equal(successor);
  });

  it('should read liveness from the running task when no check is injected', async () => {
    // Arrange — three owners: this one, one that cannot exist, and one this test may not signal.
    const root = await temporaryDirectory();
    const cases = [
      { owner: globalThis.process.pid, expected: /still running/u },
      { owner: 424242, expected: /no longer running/u },
      { owner: 1, expected: /running/u },
    ];

    for (const { owner, expected } of cases) {
      const lockPath = path.join(root, `${owner}.lock`);
      await writeFile(lockPath, claimOf(owner, `held-by-${owner}`));
      const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 5 });

      // Act
      const promise = subject.run(async () => 'ran');

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
    await Promise.all([first.run(settled), second.run(settled)]);

    // Assert
    should(await readdir(root)).deepEqual([]);
  });
});
