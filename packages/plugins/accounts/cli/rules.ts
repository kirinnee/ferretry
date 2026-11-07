import type { PluginClient, TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';

/**
 * HALF B of Accounts' `fy` half (rebuild unit accounts-b): `copy …`, `plan …`, `rules …` and `account site recipe …`.
 * THIS FILE IS ACCOUNTS-B'S TO FILL: return a handler per verb, keyed exactly as the manifest declares it.
 * `./index.ts` answers every declared verb neither half returns with the skeleton sentence.
 */
export function rulesVerbs(_ctx: {
  readonly client: PluginClient;
  readonly io: TerminalIo;
}): Readonly<Record<string, VerbHandler>> {
  return {};
}
