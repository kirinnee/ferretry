/** J-0119 J-0085: the disk's pressure from a pressure-stall file, read off the hot path on a timer, and absent where there is none. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IO_PRESSURE_REFRESH_MS,
  PROC_IO_PRESSURE_PATH,
  procIoPressure,
} from '../../../host/adapters/proc-io-pressure.ts';
import { fixedClock } from '../../../testing/clock.ts';

const some = (avg10: number) => `some avg10=${avg10}.00 avg60=1.00 avg300=1.00 total=1\n`;

let folder: string;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'proc-io-pressure-'));
});
afterAll(async () => await rm(folder, { recursive: true, force: true }));

/** Waits for the in-flight read the timer started (a microtask or two of file IO). */
const settle = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, 30));
};

describe('procIoPressure', () => {
  test('reads the real pressure file by default, every five seconds', () => {
    expect(PROC_IO_PRESSURE_PATH).toBe('/proc/pressure/io');
    expect(IO_PRESSURE_REFRESH_MS).toBe(5_000);
    expect(procIoPressure(fixedClock()).current()).toBeUndefined();
  });

  test('J-0119 starting reads now and then each period; current() is the last reading, and stopping ends the timer', async () => {
    const path = join(folder, 'io');
    await writeFile(path, some(3));
    const clock = fixedClock();
    const source = procIoPressure(clock, path, 1_000);
    const stop = source.start();
    await settle();
    expect(source.current()).toEqual({ some: { avg10: 3, avg60: 1, avg300: 1 } });
    await writeFile(path, some(40));
    await clock.advance(1_000);
    await settle();
    expect(source.current()?.some.avg10).toBe(40);
    stop();
    expect(clock.pending()).toBe(0);
    await writeFile(path, some(5));
    await clock.advance(5_000);
    await settle();
    expect(source.current()?.some.avg10).toBe(40);
  });

  test('a file that is missing, or holds nothing usable, is no reading and never throws', async () => {
    const path = join(folder, 'later');
    const source = procIoPressure(fixedClock(), path, 1_000);
    await source.refresh();
    expect(source.current()).toBeUndefined();
    await writeFile(path, some(7));
    await source.refresh();
    expect(source.current()?.some.avg10).toBe(7);
    await writeFile(path, 'garbage');
    await source.refresh();
    expect(source.current()).toBeUndefined();
  });

  test('a read that was in flight when the timer was stopped changes nothing', async () => {
    const path = join(folder, 'inflight');
    await writeFile(path, some(9));
    const source = procIoPressure(fixedClock(), path, 1_000);
    const stop = source.start();
    stop();
    await settle();
    expect(source.current()).toBeUndefined();
  });
});
