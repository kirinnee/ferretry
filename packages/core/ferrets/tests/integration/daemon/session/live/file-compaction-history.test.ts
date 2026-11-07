import { describe, it } from 'bun:test';
import should from 'should';
import { FileCompactionHistory } from '../../../../src/adapters/session/live/index.ts';
import type { CompactionRecord, FileSystemPort } from '../../../../src/lib/index.ts';

/**
 * The compaction duration history over a file port.
 *
 * WHAT IT HAS TO GET RIGHT. The history only feeds an estimate, so losing it must cost nothing but
 * precision: an absent, corrupt or unreadable file is an empty history. And two compactions finishing
 * together must both be kept.
 */

const FILE = '/state/compaction-history.json';

interface Disk {
  text: string | undefined;
  readFails: boolean;
  writes: number;
}

const portOver = (disk: Disk): FileSystemPort =>
  ({
    readText: async () => {
      if (disk.readFails) throw new Error('EIO');
      return disk.text;
    },
    writeTextAtomic: async (_file: string, text: string) => {
      disk.writes += 1;
      // A slow disk, so two unserialized writers would both read the same old document.
      await new Promise(resolve => setImmediate(resolve));
      disk.text = text;
    },
  }) as unknown as FileSystemPort;

const entry = (durationMs: number, over: Partial<CompactionRecord> = {}): CompactionRecord => ({
  harness: 'claude',
  durationMs,
  at: '2026-10-18T10:00:00.000Z',
  ...over,
});

const subject = (disk: Disk = { text: undefined, readFails: false, writes: 0 }) => ({
  disk,
  history: new FileCompactionHistory(portOver(disk), FILE),
});

describe('FileCompactionHistory', () => {
  it('should read an absent, unreadable, unparseable or malformed file as an empty history', async () => {
    for (const disk of [
      { text: undefined, readFails: false, writes: 0 },
      { text: undefined, readFails: true, writes: 0 },
      { text: '{not json', readFails: false, writes: 0 },
      { text: '{"version":2,"entries":[]}', readFails: false, writes: 0 },
      { text: '{"version":1,"entries":[{"harness":"claude","durationMs":-1,"at":"x"}]}', readFails: false, writes: 0 },
    ] satisfies Disk[]) {
      should(await subject(disk).history.durations('claude', undefined)).deepEqual([]);
    }
  });

  it('should keep what it records and answer for the harness asked about', async () => {
    // Arrange
    const { history, disk } = subject();

    // Act
    await history.record(entry(10_000));
    await history.record(entry(20_000, { harness: 'codex' }));

    // Assert
    should(await history.durations('claude', undefined)).deepEqual([10_000]);
    should(await history.durations('codex', undefined)).deepEqual([20_000]);
    should(JSON.parse(disk.text as string).version).equal(1);
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
    should(JSON.parse(disk.text as string).entries).have.length(50);
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
    const disk: Disk = { text: undefined, readFails: false, writes: 0 };
    const failing = {
      ...portOver(disk),
      writeTextAtomic: async () => Promise.reject(new Error('ENOSPC')),
    } as FileSystemPort;
    const broken = new FileCompactionHistory(failing, FILE);
    const { history } = subject(disk);

    // Act
    const failure = await broken.record(entry(1_000)).catch(error => error as Error);
    await history.record(entry(2_000));

    // Assert
    should((failure as Error).message).equal('ENOSPC');
    should(await history.durations('claude', undefined)).deepEqual([2_000]);
  });
});
