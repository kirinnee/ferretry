import { randomUUID } from 'node:crypto';
import {
  AGENDA_FILES,
  readAgendaFile,
  isAgendaSessionId,
  parseAgendaLedger,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
} from '../../lib/agenda/index.ts';
import { FileAgendaFileStore } from './file-agenda-file-store.ts';

/** Raised when a durable board cannot safely be supplied to the state machine. */
export class InvalidAgendaLedgerError extends Error {
  constructor(readonly file: string) {
    super(`invalid agenda ledger: ${file}`);
  }
}

/**
 * Durable per-session agenda storage, as `agenda.json` (a board written before the rename is read from
 * `attention.json` until the migration moves it, and every write goes to `agenda.json`). The owning daemon process supplies one
 * instance, so the keyed queue serializes every read-modify-write transition.
 */
export class FileAgendaLedgerRepository implements AgendaLedgerRepository {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly files: FileAgendaFileStore;

  /** `ready` settles when the agenda files migration has finished; no read or write goes to disk before it. */
  constructor(
    sessionDirectory: (sessionId: string) => string,
    uniqueId: () => string = randomUUID,
    private readonly ready: Promise<unknown> = Promise.resolve(),
  ) {
    this.files = new FileAgendaFileStore(sessionDirectory, uniqueId);
  }

  file(sessionId: string): string {
    this.assertSessionId(sessionId);
    return this.files.file(sessionId, AGENDA_FILES.ledger.current);
  }

  async read(sessionId: string): Promise<AgendaLedger | null> {
    this.assertSessionId(sessionId);
    await this.ready;
    const found = await readAgendaFile(this.files, sessionId, 'ledger');
    if (found === undefined) return null;
    try {
      const ledger = parseAgendaLedger(JSON.parse(found.text), sessionId);
      if (ledger === null) throw new Error('invalid ledger');
      return ledger;
    } catch {
      throw new InvalidAgendaLedgerError(this.files.file(sessionId, found.name));
    }
  }

  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    this.assertSessionId(sessionId);
    return await this.serial(sessionId, async () => {
      const mutation = apply(await this.read(sessionId));
      if (mutation.ok && mutation.changed) await this.write(sessionId, mutation.ledger);
      return mutation;
    });
  }

  private async write(sessionId: string, ledger: AgendaLedger): Promise<void> {
    await this.files.writeAtomic(sessionId, AGENDA_FILES.ledger.current, `${JSON.stringify(ledger, null, 2)}\n`);
  }

  private async serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, settled);
    try {
      return await result;
    } finally {
      if (this.tails.get(sessionId) === settled) this.tails.delete(sessionId);
    }
  }

  private assertSessionId(sessionId: string): void {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
  }
}
