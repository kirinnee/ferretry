import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { newestMessageScanning } from '../../../lib/session/pack/outbox-scan.ts';
import type { SentMessage } from '../../../lib/session/pack/subtree.ts';
import { type SessionId, tryParseSessionId } from '../../../lib/session-id.ts';

/**
 * The newest message a session sent to one recipient, read from the END of its `outbox.jsonl` so a long
 * conversation costs the same as a short one. The scan itself (chunking, bound) is `newestMessageScanning`.
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
      return await newestMessageScanning(
        {
          size,
          read: async (offset, length) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            return buffer.subarray(0, bytesRead);
          },
        },
        to,
      );
    } finally {
      await handle.close();
    }
  }
}
