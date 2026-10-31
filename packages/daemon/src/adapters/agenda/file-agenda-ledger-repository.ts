import { randomUUID } from 'node:crypto';
import {
  AGENDA_FILES,
  type AgendaFileStore,
  readAgendaFile,
  isAgendaSessionId,
  parseAgendaLedger,
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
} from '../../lib/agenda/index.ts';
import { deepFreezeJson, type JsonValue } from '../../lib/json.ts';
import { FileAgendaFileStore } from './file-agenda-file-store.ts';

/** Raised when a durable board cannot safely be supplied to the state machine. */
export class InvalidAgendaLedgerError extends Error {
  constructor(readonly file: string) {
    super(`invalid agenda ledger: ${file}`);
  }
}

/** How many sessions' parsed agendas are kept before the whole cache is dropped and refilled from disk. */
const AGENDA_CACHE_LIMIT = 2_048;

/** One session's agenda as last parsed: which file, how it stood, and what it said. */
interface CachedLedger {
  readonly name: string;
  readonly identity: string;
  readonly ledger: AgendaLedger;
}

/**
 * Durable per-session agenda storage, as `agenda.json` (a board written before the rename is read from
 * `attention.json` until the migration moves it, and every write goes to `agenda.json`). The owning daemon process supplies one
 * instance, so the keyed queue serializes every read-modify-write transition.
 *
 * A PARSED COPY IS KEPT PER SESSION, against the identity of the file it was read from. A board read opens
 * the agenda of every ferret on the board — some two hundred — and checking each one's ledger entry by entry
 * was most of what it cost. The file stays the only truth: every write lands on disk first and then drops the
 * copy, every read first asks the file how it stands (one `stat`), and a file changed by anyone — this
 * daemon, the CLI, a second process, a person with an editor — is a new identity, read and parsed again. The
 * copy is frozen, because every reader of this session shares it, and lives in memory only: a restart starts
 * from the files.
 */
export class FileAgendaLedgerRepository implements AgendaLedgerRepository {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, CachedLedger>();
  private readonly files: AgendaFileStore & Pick<FileAgendaFileStore, 'file'>;

  /** `ready` settles when the agenda files migration has finished; no read or write goes to disk before it. */
  constructor(
    sessionDirectory: (sessionId: string) => string,
    uniqueId: () => string = randomUUID,
    private readonly ready: Promise<unknown> = Promise.resolve(),
    files?: AgendaFileStore & Pick<FileAgendaFileStore, 'file'>,
  ) {
    this.files = files ?? new FileAgendaFileStore(sessionDirectory, uniqueId);
  }

  file(sessionId: string): string {
    this.assertSessionId(sessionId);
    return this.files.file(sessionId, AGENDA_FILES.ledger.current);
  }

  async read(sessionId: string): Promise<AgendaLedger | null> {
    this.assertSessionId(sessionId);
    await this.ready;
    const { identity, readIdentified } = this.files;
    if (identity === undefined || readIdentified === undefined) {
      const found = await readAgendaFile(this.files, sessionId, 'ledger');
      return found === undefined ? null : this.parse(sessionId, found.name, found.text);
    }
    // THE READER'S RULE (`readAgendaFile`): the new name when it exists, else the old one.
    for (const name of [AGENDA_FILES.ledger.current, AGENDA_FILES.ledger.legacy]) {
      const now = await identity.call(this.files, sessionId, name);
      if (now === undefined) continue;
      const cached = this.cache.get(sessionId);
      if (cached !== undefined && cached.name === name && cached.identity === now) return cached.ledger;
      const read = await readIdentified.call(this.files, sessionId, name);
      if (read === undefined) continue;
      const ledger = deepFreezeJson(
        this.parse(sessionId, name, read.text) as unknown as JsonValue,
      ) as unknown as AgendaLedger;
      if (this.cache.size >= AGENDA_CACHE_LIMIT) this.cache.clear();
      this.cache.set(sessionId, { name, identity: read.identity, ledger });
      return ledger;
    }
    this.cache.delete(sessionId);
    return null;
  }

  private parse(sessionId: string, name: string, text: string): AgendaLedger {
    try {
      const ledger = parseAgendaLedger(JSON.parse(text), sessionId);
      if (ledger === null) throw new Error('invalid ledger');
      return ledger;
    } catch {
      throw new InvalidAgendaLedgerError(this.files.file(sessionId, name));
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
    try {
      await this.files.writeAtomic(sessionId, AGENDA_FILES.ledger.current, `${JSON.stringify(ledger, null, 2)}\n`);
    } finally {
      // After the disk, whether or not it landed: the next read asks the file. A read racing this write may
      // keep the old copy, but against the old file's identity, which the next read no longer finds.
      this.cache.delete(sessionId);
    }
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
