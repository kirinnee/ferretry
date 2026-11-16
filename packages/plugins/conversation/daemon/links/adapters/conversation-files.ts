import { HARNESS_HISTORY_READ_MAX_BYTES, type HarnessHistoryFiles } from '@ferretry/core-ferrets/contract';
import type { ConversationFileEntry, ConversationFiles } from '../lib/conversation-describer.ts';

/**
 * The read-only `ConversationFiles` port over one history tree a harness handed over (`HarnessHistoryFiles`, G162:
 * transcripts of other tools are read in place, never written). Paths are relative to the tree. A tail is a ranged read of the
 * file's last bytes, never the file read whole.
 */
export function conversationFiles(files: HarnessHistoryFiles): ConversationFiles {
  const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

  /**
   * `length` bytes from `offset`, however many reads the port's per-read cap needs: one `read` returns at most
   * {@link HARNESS_HISTORY_READ_MAX_BYTES}, and a caller that asked for more must not be handed that prefix as if it were
   * the answer. Stops early at the end of the file (a short or empty read); `undefined` when the first read fails.
   */
  async function readRange(path: string, offset: number, length: number): Promise<Uint8Array | undefined> {
    const chunks: Uint8Array[] = [];
    let got = 0;
    while (got < length) {
      const want = Math.min(HARNESS_HISTORY_READ_MAX_BYTES, length - got);
      const chunk = await files.read(path, offset + got, want);
      if (chunk === undefined) {
        if (chunks.length === 0) return undefined;
        break;
      }
      if (chunk.length === 0) break;
      chunks.push(chunk);
      got += chunk.length;
      if (chunk.length < want) break;
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(got);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  return {
    async entries(directory): Promise<readonly ConversationFileEntry[]> {
      return (await files.entries(directory)).map(entry => ({ name: entry.name, kind: entry.kind }));
    },
    async info(file) {
      const stat = await files.stat(file);
      return stat === undefined ? undefined : { modifiedAtMs: stat.modifiedMs, size: stat.size };
    },
    async head(file, maxBytes) {
      const bytes = await readRange(file, 0, maxBytes);
      return bytes === undefined ? undefined : decode(bytes);
    },
    async tail(file, maxBytes) {
      const stat = await files.stat(file);
      if (stat === undefined) return undefined;
      const from = Math.max(0, stat.size - maxBytes);
      const bytes = await readRange(file, from, stat.size - from);
      return bytes === undefined ? undefined : decode(bytes);
    },
  };
}
