import { dirname, join } from 'node:path';
import type { FileSystemPort } from '../../../lib/ports.ts';
import type { QueueAuthor } from '../../../lib/protocol/session.ts';
import type { ResumeTurnStore } from '../../../lib/session/resume/types.ts';
import type { SessionId } from '../../../lib/session-id.ts';

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
    private readonly fileSystem: Pick<FileSystemPort, 'ensureDirectory' | 'writeTextAtomic' | 'removeFile'>,
  ) {}

  file(id: SessionId, turn: number): string {
    return join(this.sessionDirectory(id), 'turns', `turn-${String(turn).padStart(3, '0')}.md`);
  }

  async writeTurn(id: SessionId, turn: number, document: string, by?: QueueAuthor): Promise<string> {
    const file = this.file(id, turn);
    await this.fileSystem.ensureDirectory(dirname(file), 0o700);
    // Who the turn is from sits BESIDE it, never in it: the agent reads the document, the app reads this.
    if (by !== undefined) await this.atomically(authorFile(file), `${JSON.stringify(by)}\n`);
    await this.atomically(file, document);
    return file;
  }

  private async atomically(file: string, contents: string): Promise<void> {
    await this.fileSystem.writeTextAtomic(file, contents);
  }

  async clearMarkers(id: SessionId): Promise<void> {
    const directory = this.sessionDirectory(id);
    for (const marker of MARKERS) await this.fileSystem.removeFile(join(directory, `${marker}.marker`));
  }
}

/** Where a turn document's author is kept: `turn-008.md` → `turn-008.by.json`. */
function authorFile(turnFile: string): string {
  return turnFile.replace(/\.md$/u, '.by.json');
}
