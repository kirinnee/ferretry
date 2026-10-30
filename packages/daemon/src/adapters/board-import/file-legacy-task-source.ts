import { parseTaskSnapshot } from '../../lib/board-import/legacy-snapshot.ts';
import type { LegacySessionTasks, LegacyTaskSource } from '../../lib/board-import/index.ts';
import { AtomicFileWriter } from '../atomic-file/index.ts';

/**
 * Every session's old `tasks.json`, decoded by the importer's own parser and never written. A session with no
 * file, or an empty one, is left out; a file that cannot be read at all is `fatal` and nothing in it is guessed at.
 */
export class FileLegacyTaskSource implements LegacyTaskSource {
  private readonly files = new AtomicFileWriter();

  constructor(
    private readonly sessionIds: () => readonly string[],
    private readonly fileOf: (sessionId: string) => string,
  ) {}

  async read(): Promise<readonly LegacySessionTasks[]> {
    const found: LegacySessionTasks[] = [];
    for (const sessionId of this.sessionIds()) {
      const file = await this.readOne(sessionId);
      if (file.fatal || file.entries.length > 0 || file.issues.length > 0) found.push(file);
    }
    return found;
  }

  private async readOne(sessionId: string): Promise<LegacySessionTasks> {
    try {
      const text = await this.files.read(this.fileOf(sessionId));
      if (text === null) return { sessionId, entries: [], issues: [], fatal: false };
      const decoded = parseTaskSnapshot(text);
      return { sessionId, entries: decoded.snapshot.tasks, issues: decoded.parseErrors, fatal: decoded.fatal };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { sessionId, entries: [], issues: [{ scope: 'snapshot', taskId: null, detail }], fatal: true };
    }
  }
}
