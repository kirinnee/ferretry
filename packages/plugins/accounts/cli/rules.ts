import type { PluginClient, TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { ownSessionId, paneCredentialMarker, type ShellTimeContext, shellTime } from './adapters/terminal.ts';
import { rulesVerbs as rulesCommandVerbs } from './lib/rules/commands.ts';
import { RulesController } from './lib/rules/controller.ts';
import { ProtocolRulesGateway } from './lib/rules/gateway.ts';

/**
 * HALF B of Accounts' `fy` half (accounts-b): `fy rules …` over the plugin client. `copy …` and `plan …` are `./lib/copy`; `account site
 * recipe …` are the account verbs.
 */
export function rulesVerbs(
  ctx: {
    readonly client: PluginClient;
    readonly io: TerminalIo;
  } & ShellTimeContext,
): Readonly<Record<string, VerbHandler>> {
  const { nowMs, sleep } = shellTime(ctx);
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
