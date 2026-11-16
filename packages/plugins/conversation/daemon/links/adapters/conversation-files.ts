import type { HarnessHistoryFiles } from '@ferretry/core-ferrets/contract';
import type { ConversationFileEntry, ConversationFiles } from '../lib/conversation-describer.ts';

/**
 * The read-only `ConversationFiles` port over one history tree a harness handed over (`HarnessHistoryFiles`, G162:
 * transcripts of other tools are read in place, never written). Paths are relative to the tree. A tail is a ranged read of the
 * file's last bytes, never the file read whole.
 */
export function conversationFiles(files: HarnessHistoryFiles): ConversationFiles {
  const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);
  return {
    async entries(directory): Promise<readonly ConversationFileEntry[]> {
      return (await files.entries(directory)).map(entry => ({ name: entry.name, kind: entry.kind }));
    },
    async info(file) {
      const stat = await files.stat(file);
      return stat === undefined ? undefined : { modifiedAtMs: stat.modifiedMs, size: stat.size };
    },
    async head(file, maxBytes) {
      const bytes = await files.read(file, 0, maxBytes);
      return bytes === undefined ? undefined : decode(bytes);
    },
    async tail(file, maxBytes) {
      const stat = await files.stat(file);
      if (stat === undefined) return undefined;
      const from = Math.max(0, stat.size - maxBytes);
      const bytes = await files.read(file, from, stat.size - from);
      return bytes === undefined ? undefined : decode(bytes);
    },
  };
}
