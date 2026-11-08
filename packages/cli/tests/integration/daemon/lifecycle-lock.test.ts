import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileDaemonLifecycleLock } from '../../../src/adapters/daemon/lifecycle-lock.ts';
import type { ObservedProcess, ProcessScope } from '../../../src/adapters/daemon/process-incarnation.ts';
import type { DaemonLifecycleClaimRequest, IClockPort, IDaemonProcessPort } from '../../../src/lib/daemon/ports.ts';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-lock-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs) await chmod(dir, 0o700).catch(() => undefined);
  await Promise.all(dirs.splice(0).map(async dir => await rm(dir, { recursive: true, force: true })));
});

/** A clock whose sleeping moves it, so a wait of any length costs nothing. */
function clock(): IClockPort & { readonly sleeps: number[] } {
  let now = 1_700_000_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds;
      await Promise.resolve();
    },
  };
}

/** What this invocation can see: a scope, and what each pid looks like from it. */
interface Sight {
  scope: ProcessScope | undefined;
  observe: (pid: number) => ObservedProcess;
}
function incarnations(sight: Sight): {
  scope(): Promise<ProcessScope | undefined>;
  observe(pid: number): Promise<ObservedProcess>;
} {
  return {
    scope: async () => await Promise.resolve(sight.scope),
    observe: async pid => await Promise.resolve(sight.observe(pid)),
  };
}

function processes(alive: boolean): IDaemonProcessPort {
  return {
    run: async () => await Promise.reject(new Error('unused')),
    spawnDetached: async () => await Promise.reject(new Error('unused')),
    signal: () => false,
    alive: () => alive,
    holdsOpen: async () => await Promise.resolve(undefined),
  };
}

const HERE: ProcessScope = { boot: 'boot-1', namespace: 'pid:[1]' };

function request(
  lockPath: string,
  overrides: Partial<DaemonLifecycleClaimRequest> & { notes?: string[] } = {},
): DaemonLifecycleClaimRequest {
  const notes = overrides.notes ?? [];
  return {
    lockPath,
    verb: 'start',
    waitMs: 100,
    waiting: holder => {
      notes.push(`waiting: ${holder}`);
    },
    reclaimed: holder => {
      notes.push(`reclaimed: ${holder}`);
    },
    ...overrides,
  };
}

function lockFor(sight: Sight, alive = true, time = clock()): FileDaemonLifecycleLock {
  return new FileDaemonLifecycleLock(processes(alive), incarnations(sight), time, { pollMs: 10 });
}

/** A sight in which this very process is running with start time `start`. */
function runningSelf(start = 'S1', scope: ProcessScope | undefined = HERE): Sight {
  return { scope, observe: pid => (pid === process.pid ? { kind: 'running', start } : { kind: 'gone' }) };
}

describe('taking and giving up the claim on a daemon lifecycle', () => {
  it('should publish a claim that records who holds it, and remove the whole claim on release', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'locks', 'daemon.lock');
    const claim = await lockFor(runningSelf()).acquire(request(lockPath));
    const names = await readdir(lockPath);
    should(names).have.length(1);
    const document = JSON.parse(await readFile(join(lockPath, names[0] ?? ''), 'utf8')) as Record<string, unknown>;
    should(document).containEql({ format: 1, owner: process.pid, verb: 'start' });
    should(document.holder).eql({ boot: 'boot-1', namespace: 'pid:[1]', start: 'S1' });
    should(await claim.release()).be.undefined();
    should(await readdir(join(dir, 'locks'))).eql([]);
  });

  it('should record no holder when the host has no scope, or cannot see this process in it', async () => {
    const dir = await temp();
    const noScope = await lockFor({ scope: undefined, observe: () => ({ kind: 'unknown' }) }).acquire(
      request(join(dir, 'a.lock')),
    );
    const unseen = await lockFor({ scope: HERE, observe: () => ({ kind: 'gone' }) }).acquire(
      request(join(dir, 'b.lock')),
    );
    for (const name of ['a.lock', 'b.lock']) {
      const files = await readdir(join(dir, name));
      const document = JSON.parse(await readFile(join(dir, name, files[0] ?? ''), 'utf8')) as Record<string, unknown>;
      should(document).not.have.property('holder');
    }
    await noScope.release();
    await unseen.release();
  });

  it('should treat an already-absent claim as released, and say nothing is left', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    const claim = await lockFor(runningSelf()).acquire(request(lockPath));
    await rm(lockPath, { recursive: true });
    should(await claim.release()).be.undefined();
  });

  it('should leave a successor claim alone when it releases after a person cleared its own', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    const first = await lockFor(runningSelf()).acquire(request(lockPath));
    await rm(lockPath, { recursive: true });
    const second = await lockFor(runningSelf('S2')).acquire(request(lockPath));
    should(await first.release()).be.undefined();
    should(await readdir(lockPath)).have.length(1);
    should(await second.release()).be.undefined();
  });

  it('should name the directory when something other than a claim keeps it from being removed', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    const claim = await lockFor(runningSelf()).acquire(request(lockPath));
    await writeFile(join(lockPath, 'stray'), '');
    should(await claim.release()).equal(lockPath);
  });

  it('should name the path when what sits on the lock name cannot even be listed', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    const claim = await lockFor(runningSelf()).acquire(request(lockPath));
    await rm(lockPath, { recursive: true });
    await writeFile(lockPath, 'a file where the claim was');
    should(await claim.release()).equal(lockPath);
  });
});

describe('waiting for a holder that is still running', () => {
  it('should announce the wait once, then refuse naming the verb, the owner and the directory', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    await lockFor(runningSelf()).acquire(request(lockPath, { verb: 'restart' }));
    const notes: string[] = [];
    const time = clock();
    const waiter = lockFor(runningSelf(), true, time);
    const refused = waiter.acquire(request(lockPath, { notes, waitMs: 45 }));
    await should(refused).rejectedWith(
      /another daemon lifecycle command still holds .* after 0s, so start was refused/u,
    );
    await refused.catch((error: Error) => {
      should(error.name).equal('DaemonLifecycleBusyError');
      should(error.message).containEql('held by restart (owner').and.containEql('that owner is still running');
    });
    should(notes).have.length(1);
    should(notes[0]).startWith('waiting: held by restart');
    should(time.sleeps.length).be.aboveOrEqual(4);
  });

  it('should take the claim as soon as the holder lets go during the wait', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    const held = await lockFor(runningSelf()).acquire(request(lockPath));
    const time = clock();
    const sleep = time.sleep.bind(time);
    const releasing: IClockPort = {
      now: () => time.now(),
      sleep: async milliseconds => {
        await held.release();
        await sleep(milliseconds);
      },
    };
    const notes: string[] = [];
    const waiter = new FileDaemonLifecycleLock(processes(true), incarnations(runningSelf('S2')), releasing, {
      pollMs: 10,
    });
    const claim = await waiter.acquire(request(lockPath, { notes, waitMs: 1_000 }));
    should(notes).have.length(1);
    should(await claim.release()).be.undefined();
  });

  it('should use the default poll when none is given', async () => {
    const dir = await temp();
    const lock = new FileDaemonLifecycleLock(processes(true), incarnations(runningSelf()), clock());
    const claim = await lock.acquire(request(join(dir, 'daemon.lock')));
    should(await claim.release()).be.undefined();
  });
});

describe('recognising a holder that has provably exited', () => {
  /** A claim left by a holder that saw the world as `before`, then never released. */
  async function abandonedBy(lockPath: string, before: Sight): Promise<void> {
    await lockFor(before).acquire(request(lockPath, { verb: 'install' }));
  }

  it('should remove a claim from an earlier boot at once and say it was no longer running', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    await abandonedBy(lockPath, runningSelf('S1', { boot: 'boot-0', namespace: 'pid:[1]' }));
    const notes: string[] = [];
    const claim = await lockFor(runningSelf()).acquire(request(lockPath, { notes }));
    should(notes).have.length(1);
    should(notes[0]).startWith('reclaimed: install (owner').and.endWith('which is no longer running');
    should(await claim.release()).be.undefined();
  });

  it('should remove a claim whose process no longer exists in the same scope', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    await abandonedBy(lockPath, runningSelf());
    const notes: string[] = [];
    await lockFor({ scope: HERE, observe: () => ({ kind: 'gone' }) }).acquire(request(lockPath, { notes }));
    should(notes).have.length(1);
  });

  it('should remove a claim whose pid now belongs to a process that started at another moment', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    await abandonedBy(lockPath, runningSelf('S1'));
    const notes: string[] = [];
    await lockFor(runningSelf('S-later')).acquire(request(lockPath, { notes }));
    should(notes).have.length(1);
  });

  it('should refuse to call a holder in another PID namespace gone, and say it cannot be seen from here', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    await abandonedBy(lockPath, runningSelf('S1', { boot: 'boot-1', namespace: 'pid:[container]' }));
    await lockFor(runningSelf())
      .acquire(request(lockPath, { waitMs: 0 }))
      .then(
        () => should.fail('the claim must not be taken', ''),
        (error: Error) => should(error.message).containEql('another PID namespace'),
      );
  });

  it('should fall back to asking the process table when the host could not say, and wait for a live owner', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    await abandonedBy(lockPath, { scope: undefined, observe: () => ({ kind: 'unknown' }) });
    const unknownHost: Sight = { scope: undefined, observe: () => ({ kind: 'unknown' }) };
    await lockFor(unknownHost, true)
      .acquire(request(lockPath, { waitMs: 0 }))
      .then(
        () => should.fail('the claim must not be taken', ''),
        (error: Error) => should(error.message).containEql('that owner is still running'),
      );
    await lockFor(unknownHost, false)
      .acquire(request(lockPath, { waitMs: 0 }))
      .then(
        () => should.fail('the claim must not be taken', ''),
        (error: Error) => should(error.message).containEql('does not record enough to prove it has exited'),
      );
  });

  it('should also fall back to the process table when the recorded scope matches but the host could not look', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    await abandonedBy(lockPath, runningSelf());
    await lockFor({ scope: HERE, observe: () => ({ kind: 'unknown' }) }, true)
      .acquire(request(lockPath, { waitMs: 0 }))
      .then(
        () => should.fail('the claim must not be taken', ''),
        (error: Error) => should(error.message).containEql('that owner is still running'),
      );
  });

  it('should try to remove an abandoned claim only once, then explain it could not be removed', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    await abandonedBy(lockPath, runningSelf());
    // A directory nobody may write into: the dead holder's token file cannot be unlinked.
    await chmod(lockPath, 0o500);
    const notes: string[] = [];
    try {
      await lockFor({ scope: HERE, observe: () => ({ kind: 'gone' }) })
        .acquire(request(lockPath, { notes, waitMs: 30 }))
        .then(
          () => should.fail('the claim must not be taken', ''),
          (error: Error) =>
            should(error.message).containEql('that owner is no longer running, but its claim could not be removed'),
        );
      should(notes.filter(note => note.startsWith('reclaimed:'))).have.length(1);
    } finally {
      await chmod(lockPath, 0o700);
    }
  });
});

describe('what is sitting on the lock name that is not a claim', () => {
  it('should call an unreadable, mismatched or foreign claim unreadable and tell the person how to clear it', async () => {
    const dir = await temp();
    for (const [name, content] of [
      ['claim-garbage.json', 'not json'],
      ['claim-wrong.json', JSON.stringify({ format: 1, owner: 1, token: 'other', verb: 'start', at: 1 })],
      ['claim-extra.json', JSON.stringify({ format: 1, owner: 1, token: 'extra', verb: 'start', at: 1, nope: true })],
    ] as const) {
      const lockPath = join(dir, name);
      await mkdir(lockPath);
      await writeFile(join(lockPath, name), content);
      await lockFor(runningSelf())
        .acquire(request(lockPath, { waitMs: 0 }))
        .then(
          () => should.fail('the claim must not be taken', ''),
          (error: Error) => should(error.message).containEql('its claim could not be read'),
        );
    }
  });

  it('should clear an empty directory left by an interrupted release and take the name', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    await mkdir(lockPath);
    const claim = await lockFor(runningSelf()).acquire(request(lockPath));
    should(await readdir(lockPath)).have.length(1);
    await claim.release();
  });

  it('should treat a regular file on the name as contention rather than an operational failure', async () => {
    const dir = await temp();
    const lockPath = join(dir, 'daemon.lock');
    await writeFile(lockPath, 'a person left this here');
    await lockFor(runningSelf())
      .acquire(request(lockPath, { waitMs: 0 }))
      .then(
        () => should.fail('the claim must not be taken', ''),
        (error: Error) => should(error.name).equal('DaemonLifecycleBusyError'),
      );
  });

  it('should fail at once, not wait out the budget, when the claim cannot even be built', async () => {
    const dir = await temp();
    const parent = join(dir, 'sealed');
    await mkdir(parent);
    await chmod(parent, 0o500);
    const time = clock();
    const notes: string[] = [];
    await lockFor(runningSelf(), true, time)
      .acquire(request(join(parent, 'daemon.lock'), { notes, waitMs: 60_000 }))
      .then(
        () => should.fail('the claim must not be taken', ''),
        (error: NodeJS.ErrnoException) => should(error.name).not.equal('DaemonLifecycleBusyError'),
      );
    should(time.sleeps).eql([]);
    should(notes).eql([]);
  });
});
