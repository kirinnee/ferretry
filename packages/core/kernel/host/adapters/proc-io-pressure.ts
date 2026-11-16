import { readFile } from 'node:fs/promises';
import { milliseconds } from '@ferretry/std';
import type { Clock } from '../../contract/ports.ts';
import { type IoPressure, type IoPressureSource, parseIoPressure } from '../loop-health.ts';

/** The kernel's pressure-stall file for IO. */
export const PROC_IO_PRESSURE_PATH = '/proc/pressure/io';
/** How often the reading is refreshed: well inside the 10-second window the verdict is made on. */
export const IO_PRESSURE_REFRESH_MS = 5_000;

/**
 * The disk's pressure from Linux's `/proc/pressure/io`, refreshed off the hot path: `current()` is a field read, the file
 * is read by `refresh()` on the timer `start()` arms. Where the file is absent or unreadable (macOS, a kernel without PSI,
 * a container that hides it) or holds nothing parseable, the reading is `undefined`; nothing here throws.
 */
export function procIoPressure(
  clock: Pick<Clock, 'every'>,
  path: string = PROC_IO_PRESSURE_PATH,
  intervalMs: number = IO_PRESSURE_REFRESH_MS,
): IoPressureSource & { refresh(): Promise<void> } {
  let reading: IoPressure | undefined;
  let generation = 0;
  const refresh = async (): Promise<void> => {
    const mine = generation;
    let next: IoPressure | undefined;
    try {
      next = parseIoPressure(await readFile(path, 'utf8'));
    } catch {
      next = undefined;
    }
    // A read in flight when the timer was stopped lands on a stale generation and changes nothing.
    if (mine === generation) reading = next;
  };
  return {
    current: () => reading,
    refresh,
    start() {
      void refresh();
      const cancel = clock.every(milliseconds(intervalMs), () => void refresh());
      return () => {
        cancel();
        generation += 1;
      };
    },
  };
}
