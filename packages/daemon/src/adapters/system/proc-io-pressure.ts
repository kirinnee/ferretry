import { readFile } from 'node:fs/promises';
import { type IoPressure, parseIoPressure } from '@ferretry/protocol';
import type { IoPressurePort } from '../../lib/runtime/io-pressure.ts';

/** The kernel's pressure-stall file for IO. */
const PROC_IO_PRESSURE_PATH = '/proc/pressure/io';

/** How often the reading is refreshed: well inside the 10-second window the verdict is made on. */
const IO_PRESSURE_REFRESH_MS = 5_000;

/**
 * The disk's pressure from Linux's `/proc/pressure/io`, refreshed off the hot path.
 *
 * `current()` is a field read. The file is read by `refresh()`, asynchronously, on a timer `start()`
 * arms — so the meter that records a stall never touches the disk, and a stalled loop costs a late
 * refresh, not a blocked read. Where the file is absent or unreadable (macOS, a kernel without PSI, a
 * container that hides it) or holds nothing parseable, the reading is `undefined`; nothing here throws.
 */
export class ProcIoPressure implements IoPressurePort {
  #reading: IoPressure | undefined;
  #generation = 0;

  constructor(
    private readonly path: string = PROC_IO_PRESSURE_PATH,
    private readonly intervalMs: number = IO_PRESSURE_REFRESH_MS,
    private readonly readText: (path: string) => Promise<string> = async file => await readFile(file, 'utf8'),
  ) {}

  current(): IoPressure | undefined {
    return this.#reading;
  }

  /**
   * Reads the file once and caches what it says, or clears the cache when it says nothing. A read that
   * was in flight when the timer was stopped lands on a stale generation and changes nothing.
   */
  async refresh(): Promise<void> {
    const generation = this.#generation;
    let reading: IoPressure | undefined;
    try {
      reading = parseIoPressure(await this.readText(this.path));
    } catch {
      reading = undefined;
    }
    if (generation === this.#generation) this.#reading = reading;
  }

  /** Reads now and then every period, without keeping the process alive; returns what stops it. */
  start(): () => void {
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), this.intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
      this.#generation += 1;
    };
  }
}
