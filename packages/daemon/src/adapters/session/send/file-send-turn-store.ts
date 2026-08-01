import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SessionId } from '../../../lib/session-id.ts';
import type { ResumeTurnStore } from '../../../lib/session/resume/types.ts';
import type { SendTurnStore } from '../../../lib/session/send/types.ts';

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

  async writeTurn(id: SessionId, turn: number, document: string): Promise<string> {
    return await this.turns.writeTurn(id, turn, document);
  }

  async clearMarkers(id: SessionId): Promise<void> {
    await this.turns.clearMarkers(id);
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
