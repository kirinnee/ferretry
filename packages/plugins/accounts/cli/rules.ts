import type { PluginClient, TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { nowMs, ownSessionId, paneCredentialMarker, sleep } from './adapters/terminal.ts';
import { rulesVerbs as rulesCommandVerbs } from './lib/rules/commands.ts';
import { RulesController } from './lib/rules/controller.ts';
import { ProtocolRulesGateway } from './lib/rules/gateway.ts';

/**
 * HALF B of Accounts' `fy` half (accounts-b): `fy rules …` over the plugin client. `copy …`, `plan …` and `account site
 * recipe …` are not ported by half b yet, so `./index.ts` answers them with the skeleton sentence.
 */
export function rulesVerbs(ctx: {
  readonly client: PluginClient;
  readonly io: TerminalIo;
}): Readonly<Record<string, VerbHandler>> {
  const controller = new RulesController({
    gateway: new ProtocolRulesGateway(ctx.client),
    out: { success: message => ctx.io.out(`${message}\n`), diagnostic: message => ctx.io.err(`${message}\n`) },
    ownSessionId: ownSessionId(),
    agentCredential: paneCredentialMarker(),
    sleep,
    nowMs,
    red: text => text,
  });
  return rulesCommandVerbs(controller, ctx.io);
}
