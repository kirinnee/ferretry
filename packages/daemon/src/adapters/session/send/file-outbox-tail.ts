import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { OUTBOX_SCAN_BYTES, scanOutbox } from '../../../lib/session/pack/outbox-scan.ts';
import type { OutboxLookup, SentMessage } from '../../../lib/session/pack/subtree.ts';
import { type SessionId, tryParseSessionId } from '../../../lib/session-id.ts';

/**
 * The newest message a session sent to one recipient, read from the END of its `outbox.jsonl` so a long
 * conversation costs the same as a short one. The scan itself (chunking, bound) is `newestMessageScanning`.
 */
export class FileOutboxTail {
  constructor(private readonly sessionDirectory: (id: SessionId) => string) {}

  async newestMessageTo(sessionId: string, to: string): Promise<SentMessage | undefined> {
    return (await this.scan(sessionId, to)).message;
  }

  /** {@link newestMessageTo} reading at most `maxBytes` of the outbox, and saying how many it read. */
  async scan(sessionId: string, to: string, maxBytes: number = OUTBOX_SCAN_BYTES): Promise<OutboxLookup> {
    const none: OutboxLookup = { message: undefined, scanned: 0 };
    const id = tryParseSessionId(sessionId);
    if (id === undefined) return none;
    const handle = await open(join(this.sessionDirectory(id), 'channel', 'outbox.jsonl'), 'r').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (handle === undefined) return none;
    try {
      const { size } = await handle.stat();
      return await scanOutbox(
        {
          size,
          read: async (offset, length) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return buffer.subarray(0, bytesRead);
          },
        },
        to,
        undefined,
        maxBytes,
      );
    } finally {
      await handle.close();
    }
  }
}
