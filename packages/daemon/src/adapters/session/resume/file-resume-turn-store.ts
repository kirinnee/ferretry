import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionId } from '../../../lib/session-id.ts';
import type { ResumeTurnStore } from '../../../lib/session/resume/types.ts';

/** Completion markers a previous turn may have left behind. */
const MARKERS = ['done', 'needs-help', 'process-exit'] as const;

/**
 * Turn documents inside the session's own private directory.
 *
 * The write is atomic and the turn is numbered, so a revived agent reads its NEW assignment and a
 * retried relaunch re-delivers exactly the same one. Markers are removed before the relaunch: a
 * `done` file left by the previous turn would end the new turn the moment it started.
 */
export class FileResumeTurnStore implements ResumeTurnStore {
  constructor(
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  file(id: SessionId, turn: number): string {
    return join(this.sessionDirectory(id), 'turns', `turn-${String(turn).padStart(3, '0')}.md`);
  }

  async writeTurn(id: SessionId, turn: number, document: string): Promise<string> {
    const file = this.file(id, turn);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    await writeFile(temporary, document, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
    return file;
  }

  async clearMarkers(id: SessionId): Promise<void> {
    const directory = this.sessionDirectory(id);
    for (const marker of MARKERS) await rm(join(directory, `${marker}.marker`), { force: true });
  }
}
