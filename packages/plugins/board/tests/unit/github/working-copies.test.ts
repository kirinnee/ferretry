import { describe, it } from 'bun:test';
import type { SpawnResult } from '@ferretry/kernel/contract';
import should from 'should';
import { GitSpawnCopies, KEPT_FOR_MS } from '../../../daemon/adapters/github.ts';
import { jittered, WATCH_TICK_MS } from '../../../daemon/lib/github/index.ts';

const ok = (stdout: string): SpawnResult => ({ exitCode: 0, signal: null, stdout, stderr: '' });

/** A working copy whose checked-out branch the test switches, answering git as the kernel's spawn would. */
const rig = () => {
  const folder = { branch: 'main', origin: 'git@github.com:kirinnee/ferretry.git' };
  const asked: string[][] = [];
  const clock = { ms: 0 };
  const pending: (() => void)[] = [];
  const hold = { on: false };
  const copies = new GitSpawnCopies(
    {
      run: async (program: string, args: readonly string[]) => {
        asked.push([program, ...args]);
        if (hold.on) await new Promise<void>(resolve => pending.push(resolve));
        return args.includes('get-url') ? ok(`${folder.origin}\n`) : ok(`refs/heads/${folder.branch}\n`);
      },
    },
    { nowMs: () => clock.ms },
  );
  return {
    folder,
    asked,
    clock,
    copies,
    hold,
    pending,
    branchAsks: () => asked.filter(a => a.includes('symbolic-ref')).length,
  };
};

describe('GitSpawnCopies: what is kept', () => {
  it('should never keep an answer past the shortest gap between two ticks', () => {
    should(KEPT_FOR_MS).be.below(jittered(WATCH_TICK_MS, 0));
  });

  it('should see a branch switched since the last tick, asking git again', async () => {
    // Arrange
    const subject = rig();
    should(await subject.copies.branchOf('/work/ferretry')).equal('main');

    // Act: `git checkout -b feat/x`, then the next tick.
    subject.folder.branch = 'feat/x';
    subject.clock.ms += jittered(WATCH_TICK_MS, 0);

    // Assert
    should(await subject.copies.branchOf('/work/ferretry')).equal('feat/x');
    should(subject.branchAsks()).equal(2);
  });

  it('should share one answer within a tick: several cards in one folder ask git once', async () => {
    const subject = rig();
    should(await subject.copies.branchOf('/work/ferretry')).equal('main');
    subject.clock.ms += KEPT_FOR_MS - 1;
    should(await subject.copies.branchOf('/work/ferretry')).equal('main');
    should(subject.branchAsks()).equal(1);
  });

  it('should share a question already being asked, never asking git twice at once', async () => {
    // Arrange
    const subject = rig();
    subject.hold.on = true;

    // Act
    const first = subject.copies.branchOf('/work/ferretry');
    const second = subject.copies.branchOf('/work/ferretry');
    await Promise.resolve();
    for (const release of subject.pending.splice(0)) release();

    // Assert
    should(await Promise.all([first, second])).deepEqual(['main', 'main']);
    should(subject.branchAsks()).equal(1);
  });

  it('should not keep a question git could not answer', async () => {
    // Arrange: a git that cannot start, then one that can.
    let missing = true;
    const asked: string[] = [];
    const copies = new GitSpawnCopies(
      {
        run: async (_program: string, args: readonly string[]) => {
          asked.push(args.join(' '));
          if (missing) throw Object.assign(new Error('Executable not found in $PATH: "git"'), { code: 'ENOENT' });
          return ok('refs/heads/main\n');
        },
      },
      { nowMs: () => 0 },
    );

    // Act / Assert
    should(await copies.branchOf('/work/ferretry')).be.null();
    missing = false;
    should(await copies.branchOf('/work/ferretry')).equal('main');
    should(asked).have.length(2);
  });
});
