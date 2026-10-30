import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SendReproofCounts, SendReproofMarker } from '../../../lib/session/send/index.ts';

/** The record that the one-time re-proof of old "not delivered" sends finished: one small document in the daemon's home. */
export class FileSendReproofMarker implements SendReproofMarker {
  constructor(private readonly file: string) {}

  async ran(): Promise<boolean> {
    try {
      await readFile(this.file, 'utf8');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async record(at: string, counts: SendReproofCounts): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ v: 1, ranAt: at, ...counts }, undefined, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
