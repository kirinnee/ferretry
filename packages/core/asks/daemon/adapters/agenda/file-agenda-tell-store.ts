import { AGENDA_FILES, type AgendaTells, type AgendaTellStore, AgendaTellsSchema } from '../../lib/agenda/index.ts';
import type { StateAgendaFiles } from './state-agenda-files.ts';

/**
 * Each ferret's held and sent tells, as `agenda-tells.json` beside its board. Writes replace the file atomically; the
 * teller serializes every read-modify-write per ferret. A damaged file is read as no file: a tell is information, and
 * the ferret can read its state, so the one thing lost is what that file held.
 */
export class FileAgendaTellStore implements AgendaTellStore {
  constructor(private readonly files: Pick<StateAgendaFiles, 'read' | 'writeAtomic'>) {}

  async read(sessionId: string): Promise<AgendaTells | null> {
    const text = await this.files.read(sessionId, AGENDA_FILES.tells);
    if (text === undefined) return null;
    try {
      const parsed = AgendaTellsSchema.safeParse(JSON.parse(text));
      return parsed.success && parsed.data.sessionId === sessionId ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async write(tells: AgendaTells): Promise<void> {
    await this.files.writeAtomic(tells.sessionId, AGENDA_FILES.tells, `${JSON.stringify(tells, null, 2)}\n`);
  }
}
