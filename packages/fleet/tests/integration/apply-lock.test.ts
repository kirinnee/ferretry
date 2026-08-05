import { afterEach, describe, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
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

/**
 * Put a claim on disk the way the lock itself does: a directory holding one token-named file.
 *
 * The shape matters to these tests, not just to the code. A claim is non-empty by construction,
 * which is what makes publishing it exclusive and releasing it unable to reach anybody else's.
 */
const publishClaim = async (lockPath: string, document: string, token = 'held-elsewhere'): Promise<string> => {
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  const file = path.join(lockPath, `claim-${token}.json`);
  await writeFile(file, document, { mode: 0o600 });
  return file;
};

/** Whatever claim document the lock name currently holds. */
const claimDocument = async (lockPath: string): Promise<string> => {
  const name = (await readdir(lockPath)).find(candidate => candidate.startsWith('claim-')) ?? '';
  return await readFile(path.join(lockPath, name), 'utf8');
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * A successor taking the lock the way the lock itself would: one rename of a fully-formed claim.
 *
 * Used for the interleavings where the name has just been freed. Renaming is the only publication
 * path, so a test that wrote the claim in place would be proving something about a state the code
 * never produces.
 */
const supersede = async (lockPath: string, token = 'the-successor', owner = 1): Promise<string> => {
  const staged = path.join(path.dirname(lockPath), `.fy-fleet-apply.${token}.staged`);
  await mkdir(staged, { recursive: true, mode: 0o700 });
  const document = claimOf(owner, token, 0);
  await writeFile(path.join(staged, `claim-${token}.json`), document, { mode: 0o600 });
  // Production removes an empty release residue explicitly instead of depending on the POSIX-only
  // rename-over-empty-directory behaviour. Mirror that publication path so this interleaving means
  // the same thing on every supported platform.
  try {
    await rmdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await rename(staged, lockPath);
  return document;
};

/** A person clearing an abandoned claim, which is what the refusal message tells them to do. */
const clearClaim = async (lockPath: string): Promise<void> => {
  await rm(lockPath, { recursive: true, force: true });
};

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
    should(await exists(lockPath)).be.false();
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

  it('should recreate a first-run fleet directory when the same lock object is acquired again', async () => {
    // Arrange — release removes a fleet directory this lock created when the protected work left it
    // empty. The object itself outlives that acquisition, so creation evidence must not leak from
    // the first use and make the second one skip the directory it needs.
    const parent = await temporaryDirectory();
    const fleet = path.join(parent, 'fleet');
    const lockPath = path.join(fleet, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });

    // Act
    const first = await held(subject, async () => 'first');
    should(await exists(fleet)).be.false();
    const second = await held(subject, async () => 'second');

    // Assert — both acquisitions ran and each accounted for its own empty first-run directory.
    should(first).equal('first');
    should(second).equal('second');
    should(await exists(fleet)).be.false();
  });

  it('should leave an abandoned claim in place and name it for recovery', async () => {
    // Arrange — taking it over automatically cannot be done atomically, so it is not attempted.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const abandoned = claimOf(424242, 'abandoned', 0);
    await publishClaim(lockPath, abandoned, 'abandoned');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10, isOwnerAlive: () => false });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/owner 424242.*no longer running.*can be removed/su);
    should(await claimDocument(lockPath)).equal(abandoned);
  });

  it('should wait out a live owner however long its apply has been running', async () => {
    // Arrange — age alone is never a reason to take a lock; a large fleet legitimately takes time.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const ancient = claimOf(1, 'slow-but-healthy', 0);
    await publishClaim(lockPath, ancient, 'slow-but-healthy');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10, isOwnerAlive: () => true });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/owner 1 at .*still running/su);
    should(await claimDocument(lockPath)).equal(ancient);
  });

  it('should never destroy a claim it cannot read', async () => {
    // Arrange — unreadable evidence proves nothing about whether an owner is still working.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await publishClaim(lockPath, 'not json at all\n');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10 });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/claim could not be read/u);
    should(await claimDocument(lockPath)).equal('not json at all\n');
  });

  it('should never destroy a claim whose shape it does not recognise', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await publishClaim(lockPath, JSON.stringify({ owner: 'not-a-number' }));
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10 });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/claim could not be read/u);
    should(await claimDocument(lockPath)).equal(JSON.stringify({ owner: 'not-a-number' }));
  });

  it('should refuse a claim whose filename and document name different tokens', async () => {
    // Arrange — the filename is the release proof and the document is the diagnostic evidence. A
    // pair that disagrees was not published by this lock and must never be treated as canonical.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const document = claimOf(1, 'document-token');
    await publishClaim(lockPath, document, 'filename-token');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 0 });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/claim could not be read/u);
    should(await claimDocument(lockPath)).equal(document);
  });

  it('should take over an empty directory left on the lock name, which is not a claim', async () => {
    // Arrange — a claim is a directory holding its token file, and it is published in one rename, so
    // it is never *observed* empty. An empty directory on the name is therefore residue and not
    // somebody's lock; refusing it would leave every future apply blocked by nothing at all.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await mkdir(lockPath);
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10 });

    // Act
    const actual = await held(subject, async () => 'ran');

    // Assert — taken, used, and given back.
    should(actual).equal('ran');
    should(await exists(lockPath)).be.false();
  });

  it('should refuse, and never destroy, a non-empty directory that is not a claim', async () => {
    // Arrange — something is on the name and it is not ours to interpret, let alone remove.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await mkdir(path.join(lockPath, 'somebody-elses'), { recursive: true });
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10 });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert — nothing here ever takes a name over, whatever is sitting on it.
    await should(promise).be.rejectedWith(/claim could not be read/u);
    should(await readdir(lockPath)).deepEqual(['somebody-elses']);
  });

  it('should refuse, and never destroy, a claim file written by an older release', async () => {
    // Arrange — the claim used to be a single regular file. A daemon running this code must not
    // mistake one for a free name: renaming a directory onto a file fails, and that refusal is the
    // correct answer rather than an error to route around.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await writeFile(lockPath, claimOf(1, 'written-by-an-older-release'));
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 10 });

    // Act
    const promise = held(subject, async () => 'ran');

    // Assert
    await should(promise).be.rejectedWith(/claim could not be read/u);
    should((await lstat(lockPath)).isFile()).be.true();
  });

  it('should report residue when a superseded holder finds somebody else’s claim', async () => {
    // Arrange — the earlier version returned "no residue" here, which told a successful apply the
    // fleet was free while a claim sat on disk blocking every later one.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });

    // Act — a person clears the stale claim and somebody else takes the freed name.
    const token = await subject.acquire();
    await clearClaim(lockPath);
    const published = await supersede(lockPath, 'successor', 2);
    const residue = await subject.release(token);

    // Assert
    should(residue).equal(lockPath);
    should(await claimDocument(lockPath)).equal(published);
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
    let published = '';

    // Act — the holder's claim is replaced while it works, so its release must be a no-op.
    await held(subject, async () => {
      await clearClaim(lockPath);
      published = await supersede(lockPath, 'successor', 2);
    });

    // Assert
    should(await claimDocument(lockPath)).equal(published);
  });

  it('should give up its own claim and still name what is left blocking the name', async () => {
    // Arrange — the release removes this holder's token file and nothing else, so an unreadable
    // claim sharing the directory is not destroyed. But it will refuse every later publication, so
    // reporting a clean release would tell the apply the fleet is free when it is not.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });

    // Act
    const token = await subject.acquire();
    await publishClaim(lockPath, 'no longer parseable\n');
    const residue = await subject.release(token);

    // Assert — ours is gone, theirs is untouched, and the caller is told.
    should(residue).equal(lockPath);
    should(await claimDocument(lockPath)).equal('no longer parseable\n');
  });

  it('should report a claim it could not clear instead of throwing over the work', async () => {
    // Arrange — a release that threw from a finally would replace the apply's own outcome, so a
    // committed fleet would be reported as an unrelated filesystem error.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });

    // Act
    const token = await subject.acquire();
    await mkdir(path.join(lockPath, 'occupied'), { recursive: true });
    const residue = await subject.release(token);

    // Assert
    should(residue).equal(lockPath);
    should(await readdir(lockPath)).deepEqual(['occupied']);
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
      await publishClaim(lockPath, claimOf(owner, `held-by-${owner}`), `held-by-${owner}`);
      const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 5 });

      // Act
      const promise = held(subject, async () => 'ran');

      // Assert
      await should(promise).be.rejectedWith(expected);
    }
  });

  it('should leave a successor claim it cannot read exactly where it found it', async () => {
    // Arrange — the sequence the refusal itself invites. This holder's claim went stale, a person
    // removed it, somebody else took the name, and that successor's claim cannot be read. Treating
    // unreadable as "nothing here" would unlink the successor's lock and permit the double apply
    // this whole mechanism exists to prevent.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const superseded = new FleetApplyLock(lockPath, { pollMs: 1 });
    const token = await superseded.acquire();
    await clearClaim(lockPath);
    await publishClaim(lockPath, 'not json at all\n');

    // Act
    const residue = await superseded.release(token);

    // Assert — named as residue, and still on disk with the successor's bytes.
    should(residue).equal(lockPath);
    should(await claimDocument(lockPath)).equal('not json at all\n');
  });

  it('should leave a successor claim it can read but does not own', async () => {
    // Arrange — the same supersession, with a readable claim naming a different token.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const superseded = new FleetApplyLock(lockPath, { pollMs: 1 });
    const token = await superseded.acquire();
    await clearClaim(lockPath);
    const published = await supersede(lockPath);

    // Act
    const residue = await superseded.release(token);

    // Assert
    should(residue).equal(lockPath);
    should(await claimDocument(lockPath)).equal(published);
  });

  it('should report no residue for a claim that is simply gone', async () => {
    // Arrange — absent is not unreadable. There is nothing left to clear, so calling it residue
    // would tell the next apply the fleet is blocked by a file nobody can find.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });
    const token = await subject.acquire();
    await clearClaim(lockPath);

    // Act
    const residue = await subject.release(token);

    // Assert
    should(residue).equal(undefined);
  });

  it('should report residue when it cannot even tell whether the lock name is occupied', async () => {
    // Arrange — this holder's token file is gone, so it releases nothing; the question left is only
    // whether anything still occupies the name. Every failure used to be read as "nothing there",
    // which answers "no residue" while a claim sits on the name blocking every later apply. Only a
    // missing entry is absence; a lookup that could not be made is not an answer.
    //
    // The two observations are forced apart deterministically: the unlink lands, and the parent is
    // replaced by a regular file before the existence check rather than being raced against it.
    // That produces `ENOTDIR` without relying on permission bits, which privileged runners may
    // bypass and different hosts may interpret differently.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, 'fleet', '.fy-fleet-apply.lock');
    await mkdir(path.join(root, 'fleet'), { recursive: true });
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });
    const token = await subject.acquire();
    const blinded = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'claimExists') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as () => Promise<boolean>;
        return async (): Promise<boolean> => {
          // Somebody else's claim is on the name, and the parent stops being a directory before
          // the check — so `lstat` fails with something that is not "no such file". Move the real
          // parent aside so the successor remains intact for the assertion below.
          await clearClaim(lockPath);
          await supersede(lockPath, 'other');
          const parent = path.dirname(lockPath);
          const movedParent = path.join(root, 'fleet-with-successor');
          await rename(parent, movedParent);
          await writeFile(parent, 'not a directory\n');
          try {
            return await original.call(target);
          } finally {
            await rm(parent, { force: true });
            await rename(movedParent, parent);
          }
        };
      },
    });
    // The token file goes, so release takes its "nothing of mine is here" branch.
    await rm(path.join(lockPath, `claim-${token}.json`), { force: true });

    // Act
    const residue = await blinded.release(token);

    // Assert — named, and the claim that is genuinely there is untouched.
    should(residue).equal(lockPath);
    should(await readdir(lockPath)).deepEqual(['claim-other.json']);
  });

  it('should report no residue when the claim directory is gone before it can be looked at', async () => {
    // Arrange — the mirror image. The token file was removed, `rmdir` then failed because a
    // contender had already cleared the whole directory, and the observation that follows finds
    // nothing. Reporting that as residue tells a caller the next apply is blocked by a lock that
    // does not exist — the browser renders exactly that sentence.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });
    const token = await subject.acquire();
    const raced = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'removeIfEmpty') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (directory: string) => Promise<boolean>;
        return async (directory: string): Promise<boolean> => {
          // A contender clears the directory in the moment before the removal is attempted, so the
          // removal fails for a reason that means the name is *free*, not occupied.
          if (directory === lockPath) await clearClaim(lockPath);
          return await original.call(target, directory);
        };
      },
    });

    // Act
    const residue = await raced.release(token);

    // Assert
    should(residue).equal(undefined);
    should(await exists(lockPath)).be.false();
  });

  it('should never remove a successor that takes the name between the unlink and the rmdir', async () => {
    // Arrange — the interleaving that killed the previous design. A release that read the claim,
    // decided it was its own and then deleted it would delete whatever is there by the time the
    // delete lands, and the freed name is exactly what a successor is entitled to take. There is no
    // decision here to go stale: the token file is this holder's alone, and the `rmdir` that
    // follows removes only an *empty* directory, which a published claim never is.
    //
    // Pinned rather than raced — the successor publishes from inside the call, after this holder's
    // token file is already gone and immediately before the directory removal is attempted.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1 });
    const token = await subject.acquire();
    let published = '';
    const raced = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'removeIfEmpty') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (directory: string) => Promise<boolean>;
        return async (directory: string): Promise<boolean> => {
          if (directory === lockPath && published === '') published = await supersede(lockPath);
          return await original.call(target, directory);
        };
      },
    });

    // Act
    const residue = await raced.release(token);

    // Assert — their claim is intact, and this holder reports nothing left behind because its own
    // claim really is gone; what occupies the name now is somebody else's live lock.
    should(residue).equal(undefined);
    should(await claimDocument(lockPath)).equal(published);
  });

  it('should not take over an empty name a successor claims first', async () => {
    // Arrange — the other side of the same guard. Taking over an empty leftover directory is done
    // explicitly, and between removing it and publishing there is a moment where the name is free.
    // The publication is what has to fail if somebody else got there, and it does.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await mkdir(lockPath);
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 0 });
    let published = '';
    const raced = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'removeIfEmpty') return Reflect.get(target, property, receiver);
        const original = Reflect.get(target, property, receiver) as (directory: string) => Promise<boolean>;
        return async (directory: string): Promise<boolean> => {
          const removed = await original.call(target, directory);
          if (published === '') published = await supersede(lockPath, 'the-successor', 424242);
          return removed;
        };
      },
    });

    // Act
    const promise = raced.acquire();

    // Assert — refused, and the successor's claim is exactly as they published it.
    await should(promise).be.rejectedWith(/owner 424242/u);
    should(await claimDocument(lockPath)).equal(published);
  });

  it('should say the claim is gone rather than unreadable when it loses the race to the deadline', async () => {
    // Arrange — the name was taken on every attempt and free by the time the refusal is composed.
    // "Could not be read" would send somebody looking for a file that is not there.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    await publishClaim(lockPath, claimOf(globalThis.process.pid, 'held-elsewhere'));
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 0 });
    const removeOnRead = new Proxy(subject, {
      get(target, property, receiver) {
        if (property !== 'claim') return Reflect.get(target, property, receiver);
        return async () => {
          await clearClaim(lockPath);
          return false;
        };
      },
    });

    // Act
    const promise = removeOnRead.acquire();

    // Assert
    await should(promise).be.rejectedWith(/the claim is now gone; run the apply again/u);
  });

  it('should treat a claim it is not permitted to read as unreadable rather than absent', async () => {
    // Arrange — a directory in the claim's place: `readFile` fails with EISDIR, not ENOENT, so the
    // two error paths are told apart by the code rather than by the happy case.
    const root = await temporaryDirectory();
    const lockPath = path.join(root, '.fy-fleet-apply.lock');
    const subject = new FleetApplyLock(lockPath, { pollMs: 1, waitMs: 0 });
    const token = await subject.acquire();
    await clearClaim(lockPath);
    await mkdir(path.join(lockPath, 'occupied'), { recursive: true });

    // Act
    const residue = await subject.release(token);

    // Assert — reported, and the directory is untouched.
    should(residue).equal(lockPath);
    should(await readdir(lockPath)).deepEqual(['occupied']);
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
