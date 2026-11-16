import type { TurnUsage, UsageReader } from '@ferretry/core-ferrets/contract';
import { parseUsage } from '../../lib/harness/transcript.ts';
import type { ClaudeCore, Serves } from './core.ts';
import { transcriptText } from './transcript.ts';

export const usagePart = (core: ClaudeCore): Serves<'usage'> => {
  const usage: UsageReader = {
    turns: async (ferret, since) => {
      const text = await transcriptText(core, ferret);
      const turns: readonly TurnUsage[] = text === undefined ? [] : parseUsage(text);
      return since === undefined ? turns : turns.filter(turn => turn.at >= since);
    },
  };
  return { usage };
};
