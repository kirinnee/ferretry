import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isAttentionSessionId,
  parseAttentionLedger,
  type AttentionLedger,
  type AttentionLedgerRepository,
  type AttentionMutation,
} from '../../lib/attention/index.ts';

/** Raised when a durable board cannot safely be supplied to the state machine. */
export class InvalidAttentionLedgerError extends Error {
  constructor(readonly file: string) {
    super(`invalid attention ledger: ${file}`);
  }
}

/**
 * Durable per-session attention storage. The owning daemon process supplies one
 * instance, so the keyed queue serializes every read-modify-write transition.
 */
export class FileAttentionLedgerRepository implements AttentionLedgerRepository {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly sessionDirectory: (sessionId: string) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  file(sessionId: string): string {
    this.assertSessionId(sessionId);
    return join(this.sessionDirectory(sessionId), 'attention.json');
  }

  async read(sessionId: string): Promise<AttentionLedger | null> {
    const file = this.file(sessionId);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const ledger = parseAttentionLedger(JSON.parse(text), sessionId);
      if (ledger === null) throw new Error('invalid ledger');
      return ledger;
    } catch {
      throw new InvalidAttentionLedgerError(file);
    }
  }

  async transact(
    sessionId: string,
    apply: (current: AttentionLedger | null) => AttentionMutation,
  ): Promise<AttentionMutation> {
    this.assertSessionId(sessionId);
    return await this.serial(sessionId, async () => {
      const mutation = apply(await this.read(sessionId));
      if (mutation.ok && mutation.changed) await this.write(sessionId, mutation.ledger);
      return mutation;
    });
  }

  private async write(sessionId: string, ledger: AttentionLedger): Promise<void> {
    const file = this.file(sessionId);
    const directory = dirname(file);
    const temporary = join(directory, `.attention-${this.uniqueId()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
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
    if (!isAttentionSessionId(sessionId)) throw new Error(`not a valid attention session id: ${sessionId}`);
  }
}
