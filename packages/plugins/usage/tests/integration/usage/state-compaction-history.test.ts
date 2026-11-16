import { describe, it } from 'bun:test';
import type { CompactionRecord } from '@ferretry/core-ferrets/contract';
import type { StateDamage, StatePort, StateRead } from '@ferretry/kernel/contract';
import should from 'should';
import { COMPACTION_HISTORY_STATE } from '../../../contract/index.ts';
import { StateCompactionHistory } from '../../../daemon/adapters/usage/state-compaction-history.ts';

/**
 * The compaction duration history over the kernel's state port (v4's `file-compaction-history` test, moved with it).
 *
 * WHAT IT HAS TO GET RIGHT. The history only feeds an estimate, so losing it must cost nothing but precision: an absent,
 * damaged or unreadable file is an empty history. And two compactions finishing together must both be kept.
 */

interface Disk {
  value: { entries: readonly CompactionRecord[] } | undefined;
  mode: 'ok' | 'damaged' | 'throws';
  writeFails: boolean;
  declared: string[];
}

/** The state port over memory, with a slow write so two unserialized writers would both read the same old document. */
const portOver = (disk: Disk): StatePort =>
  ({
    read: async (file: { path: string }) => {
      disk.declared.push(file.path);
      if (disk.mode === 'throws') throw new Error('EIO');
      if (disk.mode === 'damaged') {
        const damage: StateDamage = { file: file.path, reason: 'unparsable', sentence: 'the file does not parse' };
        return { ok: false, error: damage } satisfies StateRead<unknown>;
      }
      return { ok: true, value: disk.value } satisfies StateRead<unknown>;
    },
    write: async (file: { path: string }, value: Disk['value']) => {
      disk.declared.push(file.path);
      if (disk.writeFails) throw new Error('ENOSPC');
      await new Promise(resolve => setImmediate(resolve));
      disk.value = value;
    },
  }) as unknown as StatePort;

const entry = (durationMs: number, over: Partial<CompactionRecord> = {}): CompactionRecord => ({
  harness: 'claude',
  durationMs,
  at: '2026-10-18T10:00:00.000Z',
  ...over,
});

const fresh = (): Disk => ({ value: undefined, mode: 'ok', writeFails: false, declared: [] });

const subject = (disk: Disk = fresh()) => ({ disk, history: new StateCompactionHistory(portOver(disk)) });

describe('StateCompactionHistory', () => {
  it('should read an absent, damaged or unreadable file as an empty history', async () => {
    for (const disk of [fresh(), { ...fresh(), mode: 'damaged' as const }, { ...fresh(), mode: 'throws' as const }]) {
      should(await subject(disk).history.durations('claude', undefined)).deepEqual([]);
    }
  });

  it('should keep what it records, in the declared file, and answer for the harness asked about', async () => {
    // Arrange
    const { history, disk } = subject();

    // Act
    await history.record(entry(10_000));
    await history.record(entry(20_000, { harness: 'codex' }));

    // Assert
    should(await history.durations('claude', undefined)).deepEqual([10_000]);
    should(await history.durations('codex', undefined)).deepEqual([20_000]);
    should(new Set(disk.declared)).deepEqual(new Set([COMPACTION_HISTORY_STATE.path]));
  });

  it("should use a model's own durations once it has three, and its harness's until then", async () => {
    // Arrange
    const { history } = subject();
    for (const duration of [1_000, 2_000, 3_000]) await history.record(entry(duration, { model: 'fast' }));
    for (const duration of [50_000, 60_000]) await history.record(entry(duration, { model: 'slow' }));

    // Assert
    should(await history.durations('claude', 'fast')).deepEqual([1_000, 2_000, 3_000]);
    should(await history.durations('claude', 'slow')).deepEqual([1_000, 2_000, 3_000, 50_000, 60_000]);
    should(await history.durations('claude', 'unknown')).have.length(5);
  });

  it('should answer with the newest twenty and keep only the newest fifty', async () => {
    // Arrange
    const { history, disk } = subject();
    for (let index = 1; index <= 60; index += 1) await history.record(entry(index * 1_000));

    // Act
    const durations = await history.durations('claude', undefined);

    // Assert
    should(disk.value?.entries).have.length(50);
    should(durations).have.length(20);
    should(durations[0]).equal(41_000);
    should(durations[19]).equal(60_000);
  });

  it('should keep every entry when two compactions finish together', async () => {
    // Arrange
    const { history } = subject();

    // Act
    await Promise.all([history.record(entry(1_000)), history.record(entry(2_000)), history.record(entry(3_000))]);

    // Assert
    should((await history.durations('claude', undefined)).toSorted((a, b) => a - b)).deepEqual([1_000, 2_000, 3_000]);
  });

  it('should refuse a write that fails without poisoning the writes after it', async () => {
    // Arrange
    const disk = fresh();
    const broken = new StateCompactionHistory(portOver({ ...disk, writeFails: true }));
    const { history } = subject(disk);

    // Act
    const failure = await broken.record(entry(1_000)).catch(error => error as Error);
    await history.record(entry(2_000));

    // Assert
    should((failure as Error).message).equal('ENOSPC');
    should(await history.durations('claude', undefined)).deepEqual([2_000]);
  });
});
