import { describe, it } from 'bun:test';
import { chmod, lutimes, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileScratchCollector } from '../../../src/adapters/scratch/file-scratch-collector.ts';
import { sessionView } from '../../unit/runtime/mounts/support.ts';

const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const OLD = new Date(NOW - 25 * 3_600_000);

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'fy-scratch-gc-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('FileScratchCollector', () => {
  it('should reclaim only expired non-daemon session material and retain the durable record', async () => {
    await withTempRoot(async root => {
      // Arrange
      const id = 'scratch-session';
      const directory = join(root, id);
      const record = sessionView(id, {}, { status: 'completed', finishedAt: OLD.toISOString() });
      await mkdir(join(directory, 'checkout'), { recursive: true });
      await writeFile(join(directory, 'checkout', 'output.txt'), 'build output');
      await writeFile(join(directory, 'config.json'), '{}');
      await utimes(join(directory, 'checkout', 'output.txt'), OLD, OLD);
      await utimes(join(directory, 'checkout'), OLD, OLD);
      await utimes(join(directory, 'config.json'), OLD, OLD);
      const subject = new FileScratchCollector(
        {
          list: () => [{ id }],
          config: async () => record.config,
          state: async () => record.state,
          directory: () => directory,
        },
        { alive: async () => false },
        { enabled: true, ttlHours: 24, perSweep: 20 },
        () => NOW,
      );

      // Act
      const plan = await subject.plan();
      const result = await subject.sweep();

      // Assert
      should(plan).have.length(1);
      should(plan[0]).match({ sessionId: id, eligible: true });
      should(result).match({ sessions: 1, failures: 0 });
      should(result.bytes).be.aboveOrEqual(12);
      should(await readFile(join(directory, 'config.json'), 'utf8')).equal('{}');
      should(await Bun.file(join(directory, 'checkout', 'output.txt')).exists()).be.false();
      should(subject.totals()).match({ enabled: true, reclaimedSessions: 1 });
      should(subject.totals().reclaimedBytes).be.aboveOrEqual(12);
    });
  });

  it('should refuse an otherwise eligible session when its pane is still alive', async () => {
    await withTempRoot(async root => {
      // Arrange
      const id = 'live-session';
      const directory = join(root, id);
      const record = sessionView(id, {}, { status: 'completed', finishedAt: OLD.toISOString() });
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'checkout'), 'output');
      await utimes(join(directory, 'checkout'), OLD, OLD);
      const subject = new FileScratchCollector(
        {
          list: () => [{ id }],
          config: async () => record.config,
          state: async () => record.state,
          directory: () => directory,
        },
        { alive: async () => true },
        { enabled: true, ttlHours: 24, perSweep: 20 },
        () => NOW,
      );

      // Act
      const [plan] = await subject.plan();

      // Assert
      should(plan).match({ eligible: false, reason: 'the tmux pane is still alive' });
      should(await Bun.file(join(directory, 'checkout')).exists()).be.true();
    });
  });

  it('should reclaim a write-protected tree without following a symlink out of it', async () => {
    await withTempRoot(async root => {
      // Arrange. An agent that leaves its scratch read-only would otherwise strand the directory
      // forever: `rm` answers EACCES, and the only way through is to relax the mode first. The
      // symlink is the hazard that relaxing must NOT follow — chmod through it would change the
      // mode of a file outside the scratch tree, which the collector has no business touching.
      const id = 'locked-session';
      const directory = join(root, id);
      const outside = join(root, 'outside.txt');
      const locked = join(directory, 'checkout');
      const record = sessionView(id, {}, { status: 'completed', finishedAt: OLD.toISOString() });
      await writeFile(outside, 'not the collector-s business');
      await chmod(outside, 0o644);
      await mkdir(locked, { recursive: true });
      await writeFile(join(locked, 'output.txt'), 'build output');
      await symlink(outside, join(locked, 'escape'));
      await utimes(join(locked, 'output.txt'), OLD, OLD);
      // lutimes, not utimes: ageing the LINK. utimes would follow it and backdate the target, which
      // is the very file this test asserts the collector never touches.
      await lutimes(join(locked, 'escape'), OLD, OLD);
      await utimes(locked, OLD, OLD);
      await chmod(locked, 0o500);
      const subject = new FileScratchCollector(
        {
          list: () => [{ id }],
          config: async () => record.config,
          state: async () => record.state,
          directory: () => directory,
        },
        { alive: async () => false },
        { enabled: true, ttlHours: 24, perSweep: 20 },
        () => NOW,
      );

      // Act
      const result = await subject.sweep();
      // If the sweep left the tree behind, the mode it was given would also defeat this test's own
      // cleanup, and that EACCES would mask the assertion below. Succeeds-or-not, hand the mode back.
      await chmod(locked, 0o700).catch(() => undefined);

      // Assert
      should(result).match({ sessions: 1, failures: 0 });
      should(await Bun.file(locked).exists()).be.false();
      // The link died with its directory; its target did not, and kept the mode it arrived with.
      should(await readFile(outside, 'utf8')).equal('not the collector-s business');
      should((await Bun.file(outside).stat()).mode & 0o777).equal(0o644);
    });
  });
});
