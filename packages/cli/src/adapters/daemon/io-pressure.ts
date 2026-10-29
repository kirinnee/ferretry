import { readFile } from 'node:fs/promises';
import { type IoPressure, parseIoPressure } from '@ferretry/protocol';
import type { IIoPressurePort } from '../../lib/daemon/ports.ts';

/** The kernel's pressure-stall file for IO. */
const PROC_IO_PRESSURE_PATH = '/proc/pressure/io';

/**
 * This host's disk pressure from Linux's `/proc/pressure/io`.
 *
 * Read when the daemon cannot answer for itself. `undefined` wherever there is no file (macOS, a kernel
 * without PSI, a container that hides it) or it holds nothing parseable; the read never throws.
 */
export class ProcIoPressureReader implements IIoPressurePort {
  constructor(
    private readonly path: string = PROC_IO_PRESSURE_PATH,
    private readonly readText: (path: string) => Promise<string> = async file => await readFile(file, 'utf8'),
  ) {}

  async read(): Promise<IoPressure | undefined> {
    try {
      return parseIoPressure(await this.readText(this.path));
    } catch {
      return undefined;
    }
  }
}
