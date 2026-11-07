import type { PluginClient, TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';

/**
 * PART B REGISTRATION POINT (cli). Part b replaces this stub with the verbs it owns (`logs`, `snapshot`, `events`,
 * `search`, `render`, `render guide`, `link`, `link preview`, `link keep`, `transcript`). `cli/index.ts` merges what
 * this returns and answers the rest with the skeleton sentence.
 */
export function readerVerbs(_ctx: {
  readonly client: PluginClient;
  readonly io: TerminalIo;
}): Record<string, VerbHandler> {
  return {};
}
