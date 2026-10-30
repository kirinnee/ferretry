import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BoardImportMarker, BoardImportSummary } from '../../lib/board-import/index.ts';

/** The record that the board import completed, one small document in the daemon's home. */
export class FileBoardImportMarker implements BoardImportMarker {
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

  async record(at: string, summary: BoardImportSummary): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const { imported, alreadyImported, linkedAsks, untriagedCards, proposedProjects, problems } = summary;
    const body = { v: 1, ranAt: at, imported, alreadyImported, linkedAsks, untriagedCards, proposedProjects, problems };
    await writeFile(temporary, `${JSON.stringify(body, undefined, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
