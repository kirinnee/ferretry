import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type AttentionOutbox,
  type AttentionOutboxRepository,
  AttentionOutboxSchema,
  isAttentionSessionId,
} from '../../lib/attention/index.ts';

/**
 * Each ferret's held answers, as `attention-replies.json` beside its board.
 *
 * Writes replace the file atomically (a temporary file renamed over it). The batcher serializes every
 * read-modify-write per session, so this adapter holds no lock of its own.
 *
 * A DAMAGED OUTBOX IS SET ASIDE, NOT FATAL. Refusing it, as the board refuses a damaged board, would stop
 * every later answer reaching this ferret. It is renamed to `attention-replies.json.damaged-<id>` for an
 * operator to read, and the ferret starts a fresh outbox. Items are never answered twice, so the one
 * thing lost is what that file held.
 */
export class FileAttentionOutboxRepository implements AttentionOutboxRepository {
  constructor(
    private readonly sessionDirectory: (sessionId: string) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  file(sessionId: string): string {
    if (!isAttentionSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
    return join(this.sessionDirectory(sessionId), 'attention-replies.json');
  }

  async read(sessionId: string): Promise<AttentionOutbox | null> {
    const file = this.file(sessionId);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const parsed = AttentionOutboxSchema.safeParse(parseJson(text));
    if (parsed.success && parsed.data.sessionId === sessionId) return parsed.data;
    await rename(file, `${file}.damaged-${this.uniqueId()}`);
    return null;
  }

  async write(outbox: AttentionOutbox): Promise<void> {
    const file = this.file(outbox.sessionId);
    const directory = dirname(file);
    const temporary = join(directory, `.attention-replies-${this.uniqueId()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(outbox, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
