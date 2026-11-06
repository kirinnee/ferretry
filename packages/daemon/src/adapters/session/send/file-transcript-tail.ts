import { open } from 'node:fs/promises';
import type { SendTranscriptTail } from '../../../lib/session/send/retraction.ts';
import type { SessionId } from '../../../lib/session-id.ts';

/**
 * The end of a session's own transcript, read from its last `bytes` (&B153's retraction proof). The file is the
 * one the daemon's transcript resolver binds to the session; no binding, no read. A partial first line is
 * returned as read — the proof only searches the text for record ids.
 */
export class FileTranscriptTail implements SendTranscriptTail {
  constructor(private readonly file: (id: SessionId) => Promise<string | undefined>) {}

  async tail(id: SessionId, bytes: number): Promise<string | undefined> {
    const path = await this.file(id);
    if (path === undefined) return undefined;
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, Math.max(0, bytes));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }
}
