import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgendaMigrationMarker } from '../../lib/agenda/index.ts';

/** The record that the agenda-mode migration ran, one small document in the daemon's home. */
export class FileAgendaMigrationMarker implements AgendaMigrationMarker {
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

  async record(at: string, switchedOn: readonly string[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ v: 1, ranAt: at, switchedOn }, undefined, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
