import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { InputController } from './lib/input/controller.ts';
import { inputVerbs } from './lib/input/commands.ts';
import { RouteInputGateway } from './lib/input/gateway.ts';
import { secretVerbs } from './lib/commands.ts';
import { SecretController } from './lib/secret-controller.ts';
import { RouteSecretGateway } from './lib/secret-gateway.ts';
import { StdinSecretValue } from './lib/stdin-secret-value.ts';
import { ExitStatus } from './shell.ts';

/**
 * Vault's `fy` half (§2.3): `fy secret set <name>`, the value read from stdin and never from an argument (S1, S33), and
 * the owner's `fy input ls|answer|cancel`, the value typed at a hidden prompt and never carried by a flag, argument,
 * environment variable or pipe. `secret ls`, `rm` and `use` are not declared yet (they come after merge).
 */
export default implementCli(manifest, {
  build(ctx) {
    const { client, io } = ctx;
    const exit = new ExitStatus();
    const out = { success: (message: string) => io.out(`${message}\n`) };
    const controller = new SecretController(
      new RouteSecretGateway(client),
      out,
      new StdinSecretValue('fy', ctx.readText),
    );
    const input = new InputController({
      gateway: new RouteInputGateway(client),
      out: { ...out, diagnostic: (message: string) => io.err(`${message}\n`) },
      // The shell's own hidden read: nothing is echoed, not even a mark. No terminal to ask at: no value is read.
      prompt: {
        askHidden: async message => {
          const typed = await ctx.promptHidden?.(message);
          if (typed === undefined) throw new Error('typing a value needs a terminal you are sitting at');
          return typed;
        },
      },
      interactive: io.isTty,
      // `FY_SESSION_ID` is one of the few names the shell hands a plugin: set inside a ferret's pane, which refuses here.
      ownSessionId: ctx.env?.FY_SESSION_ID,
      now: () => {
        if (ctx.clock === undefined) throw new Error('this fy shell has no clock yet; update fy');
        return ctx.clock.nowMs();
      },
      newDeliveryId: () => crypto.randomUUID(),
    });
    return { verbs: { ...secretVerbs(controller, io, exit), ...inputVerbs(input, io, exit) } };
  },
});
