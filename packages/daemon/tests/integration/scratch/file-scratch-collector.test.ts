import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
});
