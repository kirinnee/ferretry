import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type QueueAuthor, QueueAuthorSchema } from '@ferretry/protocol';
import type { ResumeTurnStore } from '../../../lib/session/resume/types.ts';
import type { SendTurnStore } from '../../../lib/session/send/types.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/**
 * Where a send leaves the documents an agent and a supervisor read.
 *
 * TURNS AND MARKERS ARE DELEGATED, not reimplemented. The revive already owns both — the numbered
 * turn document and the exact set of marker filenames it clears before a relaunch — and a second
 * implementation of that contract is how the two paths drift until a marker one path writes is one
 * the other does not clear. The composition root hands this the same store the revive holds.
 *
 * WHAT IS NEW HERE is the queued payload: a message typed into a BUSY pane that was too long to type,
 * so the composer gets a pointer and the text lives in a file. It is written before any keystroke,
 * which makes it the only copy of the message if the transport then goes wrong — and it is named by
 * the send id, so a retried request rewrites the same file rather than littering the directory.
 */
export class FileSendTurnStore implements SendTurnStore {
  constructor(
    private readonly turns: ResumeTurnStore,
    private readonly sessionDirectory: (id: SessionId) => string,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  async writeTurn(id: SessionId, turn: number, document: string, by?: QueueAuthor): Promise<string> {
    return await this.turns.writeTurn(id, turn, document, by);
  }

  async clearMarkers(id: SessionId): Promise<void> {
    await this.turns.clearMarkers(id);
  }

  /**
   * One hand-off document by its stem — `turn-008` under `turns/`, `queued-<send id>` under
   * `channel/` — or `undefined` when it is not there. The stem is the protocol's closed grammar, checked
   * by the caller, so it cannot name anything outside those two folders.
   */
  async readHandoff(id: SessionId, name: string): Promise<string | undefined> {
    const folder = name.startsWith('queued-') ? 'channel' : 'turns';
    try {
      return await readFile(join(this.sessionDirectory(id), folder, `${name}.md`), 'utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * Who a hand-off document is from, when Ferretry wrote it and said so beside it; `undefined` for a person's
   * own turn, an older document, or one whose author file cannot be read.
   */
  async readHandoffAuthor(id: SessionId, name: string): Promise<QueueAuthor | undefined> {
    const folder = name.startsWith('queued-') ? 'channel' : 'turns';
    try {
      const raw: unknown = JSON.parse(
        await readFile(join(this.sessionDirectory(id), folder, `${name}.by.json`), 'utf8'),
      );
      const parsed = QueueAuthorSchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async writeQueuedPayload(id: SessionId, sendId: string, payload: string): Promise<string> {
    const file = join(this.sessionDirectory(id), 'channel', `queued-${sendId}.md`);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // Written through a temporary file and renamed, so an agent that opens the path the instant it is
    // told about it never reads half a message.
    const temporary = `${file}.${this.uniqueId()}.tmp`;
    await writeFile(temporary, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
    return file;
  }
}
