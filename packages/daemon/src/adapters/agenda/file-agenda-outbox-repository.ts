import { randomUUID } from 'node:crypto';
import {
  AGENDA_FILES,
  type AgendaOutbox,
  type AgendaOutboxRepository,
  AgendaOutboxSchema,
  isAgendaSessionId,
} from '../../lib/agenda/index.ts';
import { FileAgendaFileStore } from './file-agenda-file-store.ts';

/**
 * Each ferret's held answers, as `agenda-replies.json` beside its board.
 *
 * Writes replace the file atomically (a temporary file renamed over it). The batcher serializes every
 * read-modify-write per session, so this adapter holds no lock of its own.
 *
 * A DAMAGED OUTBOX IS SET ASIDE, NOT FATAL. Refusing it, as the board refuses a damaged board, would stop
 * every later answer reaching this ferret. It is renamed to `agenda-replies.json.damaged-<id>` for an
 * operator to read, and the ferret starts a fresh outbox. Items are never answered twice, so the one
 * thing lost is what that file held.
 */
export class FileAgendaOutboxRepository implements AgendaOutboxRepository {
  private readonly files: FileAgendaFileStore;

  constructor(
    sessionDirectory: (sessionId: string) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {
    this.files = new FileAgendaFileStore(sessionDirectory, uniqueId);
  }

  file(sessionId: string): string {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
    return this.files.file(sessionId, AGENDA_FILES.outbox);
  }

  async read(sessionId: string): Promise<AgendaOutbox | null> {
    const text = await this.files.read(sessionId, AGENDA_FILES.outbox);
    if (text === undefined) return null;
    const parsed = AgendaOutboxSchema.safeParse(parseJson(text));
    if (parsed.success && parsed.data.sessionId === sessionId) return parsed.data;
    await this.files.rename(sessionId, AGENDA_FILES.outbox, `${AGENDA_FILES.outbox}.damaged-${this.uniqueId()}`);
    return null;
  }

  async write(outbox: AgendaOutbox): Promise<void> {
    await this.files.writeAtomic(outbox.sessionId, AGENDA_FILES.outbox, `${JSON.stringify(outbox, null, 2)}\n`);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
