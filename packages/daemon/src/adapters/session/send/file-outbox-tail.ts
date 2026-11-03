import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { SentMessage } from '../../../lib/session/pack/subtree.ts';
import { newestMessageTo } from '../../../lib/session/pack/subtree.ts';
import { type SessionId, tryParseSessionId } from '../../../lib/session-id.ts';

/** How much of an outbox's end is read: enough for the last few dozen messages, never the whole log. */
export const OUTBOX_TAIL_BYTES = 64 * 1024;

/**
 * The newest message a session sent to one recipient, read from the END of its `outbox.jsonl` so a long
 * conversation costs the same as a short one. A message older than the tail is not found: the table shows
 * the card's note instead, which is the newest of the two it can see.
 */
export class FileOutboxTail {
  constructor(private readonly sessionDirectory: (id: SessionId) => string) {}

  async newestMessageTo(sessionId: string, to: string): Promise<SentMessage | undefined> {
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return undefined;
    const handle = await open(join(this.sessionDirectory(id), 'channel', 'outbox.jsonl'), 'r').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (handle === undefined) return undefined;
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, OUTBOX_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return newestMessageTo(buffer.toString('utf8'), to);
    } finally {
      await handle.close();
    }
  }
}
