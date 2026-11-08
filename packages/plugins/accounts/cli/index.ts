import { implementCli, type VerbHandler } from '@ferretry/kernel/manifest';
import { skeletonSentence } from '@ferretry/kernel/contract';
import manifest from '../manifest.ts';
import { ownSessionId, paneCredentialMarker, recipeReader, shellTime, TerminalPrompt } from './adapters/terminal.ts';
import { AccountController } from './lib/account-controller.ts';
import { ProtocolAccountGateway } from './lib/account-gateway.ts';
import { accountVerbs } from './lib/commands.ts';
import { copyVerbs } from './lib/copy/commands.ts';
import { CopyController } from './lib/copy/controller.ts';
import { ProtocolCopyGateway, ProtocolPlanGateway } from './lib/copy/gateway.ts';
import { PlanController } from './lib/copy/plan-controller.ts';
import { TwoFactorSeedController } from './lib/factor-controller.ts';
import { ProtocolTwoFactorSeedGateway } from './lib/factor-gateway.ts';
import { FactorKeyController } from './lib/factor-keys-controller.ts';
import { SignInController } from './lib/sign-in-controller.ts';
import { rulesVerbs } from './rules.ts';
import { ExitStatus } from './shell.ts';

/**
 * Accounts' `fy` half (§2.3). Half a: `fy account …` (accounts, sign-ins, defaults, 2FA keys), today's
 * `cli/src/lib/secrets/account-*` composition with the gateways on `ctx.client` and the manifest's route keys. Half b
 * (`copy …`, `plan …`, `rules …`, `account site recipe …`) is `./rules.ts` and `./lib/copy`; every declared verb
 * neither half answers says the skeleton sentence and exits 1.
 */
export default implementCli(manifest, {
  build(ctx) {
    const { client, io } = ctx;
    const { nowMs, sleep } = shellTime(ctx);
    const exit = new ExitStatus();
    const out = { success: (message: string) => io.out(`${message}\n`) };
    const prompt = new TerminalPrompt();
    const gateway = new ProtocolAccountGateway(client);
    const ports = {
      gateway,
      out,
      prompt,
      interactive: io.isTty,
      readRecipe: recipeReader(ctx as typeof ctx & { readText?: (path: string) => Promise<string> }),
    };
    const controllers = () => ({
      accounts: new AccountController(ports),
      signIns: new SignInController(ports),
      factorKeys: new FactorKeyController(ports),
      seeds: new TwoFactorSeedController({
        gateway: new ProtocolTwoFactorSeedGateway(client),
        accounts: gateway,
        out,
        prompt,
        interactive: io.isTty,
        ownSessionId: ownSessionId(),
        sleep,
        nowMs,
      }),
    });
    const owner = { ownSessionId: ownSessionId(), agentCredential: paneCredentialMarker() };
    const copyOut = { success: out.success, diagnostic: (message: string) => io.err(`${message}\n`) };
    const copyControllers = () => ({
      copy: new CopyController({
        ...owner,
        gateway: new ProtocolCopyGateway(client),
        out: copyOut,
        sleep,
        nowMs,
      }),
      plans: new PlanController({
        ...owner,
        gateway: new ProtocolPlanGateway(client),
        out: copyOut,
        sleep,
        nowMs,
      }),
    });
    const notBuilt: VerbHandler = async () => {
      io.err(`${skeletonSentence(manifest.title)}\n`);
      return 1;
    };
    const answered: Readonly<Record<string, VerbHandler>> = {
      ...rulesVerbs({ client, io, clock: ctx.clock, sleep: ctx.sleep }),
      ...copyVerbs(copyControllers, io, exit),
      ...accountVerbs(controllers, io, exit),
    };
    return {
      verbs: Object.fromEntries(manifest.actions.cli.map(each => [each.verb, answered[each.verb] ?? notBuilt])),
    } as ReturnType<Parameters<typeof implementCli<typeof manifest>>[1]['build']>;
  },
});
