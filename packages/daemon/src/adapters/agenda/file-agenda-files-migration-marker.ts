import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgendaFilesMigrationCounts, AgendaFilesMigrationMarker } from '../../lib/agenda/index.ts';

/** The record that the agenda-files migration finished, one small document in the daemon's home. */
export class FileAgendaFilesMigrationMarker implements AgendaFilesMigrationMarker {
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

  async record(at: string, counts: AgendaFilesMigrationCounts): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ v: 1, ranAt: at, ...counts }, undefined, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
