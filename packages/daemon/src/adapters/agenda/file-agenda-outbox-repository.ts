import { randomUUID } from 'node:crypto';
import {
  AGENDA_FILES,
  readAgendaFile,
  type AgendaOutbox,
  type AgendaOutboxRepository,
  AgendaOutboxSchema,
  isAgendaSessionId,
} from '../../lib/agenda/index.ts';
import { FileAgendaFileStore } from './file-agenda-file-store.ts';

/**
 * Each ferret's held answers, as `agenda-replies.json` beside its board (`attention-replies.json` until the
 * migration moves it; it is read when the new name is absent, and every write goes to the new one).
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
    /** Settles when the agenda files migration has finished; no read or write goes to disk before it. */
    private readonly ready: Promise<unknown> = Promise.resolve(),
  ) {
    this.files = new FileAgendaFileStore(sessionDirectory, uniqueId);
  }

  file(sessionId: string): string {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
    return this.files.file(sessionId, AGENDA_FILES.outbox.current);
  }

  async read(sessionId: string): Promise<AgendaOutbox | null> {
    await this.ready;
    const found = await readAgendaFile(this.files, sessionId, 'outbox');
    if (found === undefined) return null;
    const parsed = AgendaOutboxSchema.safeParse(parseJson(found.text));
    if (parsed.success && parsed.data.sessionId === sessionId) return parsed.data;
    await this.files.rename(sessionId, found.name, `${AGENDA_FILES.outbox.current}.damaged-${this.uniqueId()}`);
    return null;
  }

  async write(outbox: AgendaOutbox): Promise<void> {
    await this.ready;
    await this.files.writeAtomic(outbox.sessionId, AGENDA_FILES.outbox.current, `${JSON.stringify(outbox, null, 2)}\n`);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
