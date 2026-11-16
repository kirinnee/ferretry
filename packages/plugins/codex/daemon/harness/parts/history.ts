import type { HarnessHistorySource } from '@ferretry/core-ferrets/contract';
import { historyFilesOver } from '@ferretry/core-ferrets/contract';
import type { HarnessPart } from './context.ts';

/** The past conversations Codex holds, offered to Conversation's index. */
export const historyPart: HarnessPart<'historySources'> = ({ options, kernel }) => {
  return {
    /**
     * The past conversations Codex holds, as read-only trees for Conversation's index: the owner's own `~/.codex` (read in
     * place through the `harness-history` root) and each ferret's home under this plugin's `agent-homes`. A link is never
     * followed, so a pooled home lists nothing itself; the pool source lists its transcripts once. Nothing is written.
     */
    async historySources(): Promise<readonly HarnessHistorySource[]> {
      const sources: HarnessHistorySource[] = [];
      const historyHome = await (options.historyHome?.() ?? Promise.resolve(undefined)).catch(() => undefined);
      if (historyHome?.startsWith('/') === true)
        sources.push({
          kind: 'computer',
          label: 'owner',
          files: historyFilesOver(kernel.roots.root('harness-history', { subfolder: historyHome })),
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
