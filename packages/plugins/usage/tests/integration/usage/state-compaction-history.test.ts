import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompactionRecord } from '@ferretry/core-ferrets/contract';
import type { StateDamage, StatePort, StateRead } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
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

/**
 * The same history over the kernel's REAL state port and a real temp folder (the host's own opening, then its port),
 * because a fake `{ ok: false }` cannot show what the kernel does with a damaged file: which damage list it joins, and
 * whether the next write goes through.
 */
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const HISTORY_FILE = 'state/usage/compaction-history.json';

async function onDisk() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-usage-compaction-'));
  homes.push(home);
  const fs = state.createNodeHostFs();
  const file = join(home, HISTORY_FILE);
  const plant = async (text: string, relative = HISTORY_FILE) => {
    await mkdir(join(home, relative, '..'), { recursive: true });
    await writeFile(join(home, relative), text);
  };
  const open = async () => {
    const opening = await state.openPluginState({
      home,
      pluginId: 'usage',
      files: [COMPACTION_HISTORY_STATE],
      fs,
      clock: { now: () => 0 as never },
      kind: 'plugin',
      liveTargets: false,
    });
    const port = state.createStatePort({
      home,
      pluginId: 'usage',
      files: [COMPACTION_HISTORY_STATE],
      fs,
      initialDamage: opening.damaged,
      initialNarrowed: opening.narrowed,
    });
    return { opening, port, history: new StateCompactionHistory(port) };
  };
  return { home, file, plant, open };
}

describe('StateCompactionHistory over the kernel state port', () => {
  it('should keep fifty entries in a format-1, owner-only file, and read them back after a restart', async () => {
    // Arrange
    const { file, open } = await onDisk();
    const { history } = await open();

    // Act
    for (let durationMs = 1; durationMs <= 60; durationMs += 1) await history.record(entry(durationMs));

    // Assert
    const stored = JSON.parse(await readFile(file, 'utf8')) as { format: number; entries: unknown[] };
    should(stored.format).equal(1);
    should(stored.entries).have.length(50);
    should((await stat(file)).mode & 0o777).equal(0o600);
    should(await (await open()).history.durations('claude', undefined)).deepEqual(
      Array.from({ length: 20 }, (_, index) => index + 41),
    );
  });

  it('should treat a corrupt file as narrowed damage: no history, and Usage itself is not damaged', async () => {
    // Arrange
    const { plant, open } = await onDisk();
    await plant('{not json');

    // Act
    const { opening, port, history } = await open();

    // Assert
    should(opening.damaged).deepEqual([]);
    should(opening.narrowed.map(damage => damage.reason)).deepEqual(['unparsable']);
    should(await history.durations('claude', undefined)).deepEqual([]);
    should(port.damaged()).deepEqual([]);
    should(port.narrowed().map(damage => damage.reason)).deepEqual(['unparsable']);
  });

  it('should drop a sample recorded while the file is corrupt, leave the file as it is, and resume once it is repaired', async () => {
    // Arrange
    const { file, plant, open } = await onDisk();
    await plant('{not json');
    const { history, port } = await open();

    // Act
    const whileDamaged = await history.record(entry(5_000)).catch(error => error as Error);
    const preserved = await readFile(file, 'utf8');
    await writeFile(file, JSON.stringify({ format: 1, entries: [entry(6_000)] }));
    await history.record(entry(7_000));

    // Assert
    should(whileDamaged).be.undefined();
    should(preserved).equal('{not json');
    should(await history.durations('claude', undefined)).deepEqual([6_000, 7_000]);
    should(port.narrowed()).deepEqual([]);
  });

  it('should start over from an empty history when the corrupt file is removed', async () => {
    // Arrange
    const { file, plant, open } = await onDisk();
    await plant('{not json');
    const { history } = await open();
    await history.durations('claude', undefined);

    // Act
    await rm(file);
    await history.record(entry(9_000));

    // Assert
    should(await history.durations('claude', undefined)).deepEqual([9_000]);
  });

  it('should not read a v4 or 5.0-preview history: the converter carries v4, a preview home accepts the loss', async () => {
    // Arrange
    const { home, plant, open } = await onDisk();
    const old = JSON.stringify({ version: 1, entries: [entry(42_000)] });
    await plant(old, 'compaction-history.json');
    await plant(old, 'state/ferrets/compaction-history.json');
    const { history } = await open();

    // Act
    const before = await history.durations('claude', undefined);
    await history.record(entry(17_000));

    // Assert
    should(before).deepEqual([]);
    should(await history.durations('claude', undefined)).deepEqual([17_000]);
    should(await readFile(join(home, 'compaction-history.json'), 'utf8')).equal(old);
    should(await readFile(join(home, 'state/ferrets/compaction-history.json'), 'utf8')).equal(old);
  });
});
