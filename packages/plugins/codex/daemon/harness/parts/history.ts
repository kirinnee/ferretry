import type { HarnessHistoryFiles, HarnessHistorySource } from '@ferretry/core-ferrets/contract';
import { historyFilesOver } from '@ferretry/core-ferrets/contract';
import type { HarnessPart } from './context.ts';

/** The past conversations Codex holds, offered to Conversation's index. */
export const historyPart: HarnessPart<'historySources'> = ({ options, kernel }) => {
  const hostHistoryOn = (): boolean => {
    try {
      return options.hostHistory?.() ?? true;
    } catch {
      return false;
    }
  };
  /**
   * The owner's history files, gated at CALL time: the conversation index keeps an issued source and reads it later, so a
   * switch turned off after the source was handed out must stop its reads too, not only the next listing.
   */
  const gated = (files: HarnessHistoryFiles): HarnessHistoryFiles => ({
    entries: async directory => (hostHistoryOn() ? await files.entries(directory) : []),
    stat: async path => (hostHistoryOn() ? await files.stat(path) : undefined),
    read: async (path, offset, length) => (hostHistoryOn() ? await files.read(path, offset, length) : undefined),
  });
  return {
    /**
     * The past conversations Codex holds, as read-only trees for Conversation's index: the owner's own `~/.codex` (read in
     * place through the `harness-history` root) and each ferret's home under this plugin's `agent-homes`. A link is never
     * followed, so a pooled home lists nothing itself; the pool source lists its transcripts once. Nothing is written.
     * The owner's own history is offered only while `hostHistory` is on (default); off, it is never opened, listed or read
     * (an already issued source answers nothing from then on: every call looks again), and nothing in `~/.codex` is touched either way. An unreadable setting reads as off: the safe side of a read.
     */
    async historySources(): Promise<readonly HarnessHistorySource[]> {
      const sources: HarnessHistorySource[] = [];
      const historyHome = hostHistoryOn()
        ? await (options.historyHome?.() ?? Promise.resolve(undefined)).catch(() => undefined)
        : undefined;
      if (historyHome?.startsWith('/') === true)
        sources.push({
          kind: 'computer',
          label: 'owner',
          files: gated(historyFilesOver(kernel.roots.root('harness-history', { subfolder: historyHome }))),
        });
      try {
        sources.push({ kind: 'pool', label: 'pool', files: historyFilesOver(kernel.roots.historyPool()) });
      } catch {
        // A composition without pooling still offers the owner's and individual homes' history.
      }
      const homes = kernel.roots.root('agent-homes');
      const top = homes.resolve('');
      if (!top.ok) return sources;
      for (const entry of await homes.entries(top.value).catch(() => [])) {
        if (entry.kind !== 'directory') continue;
        sources.push({ kind: 'ferret-home', label: entry.name, files: historyFilesOver(homes, entry.name) });
      }
      return sources;
    },
  };
};
