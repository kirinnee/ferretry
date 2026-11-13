import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { secretVerbs } from './lib/commands.ts';
import { SecretController } from './lib/secret-controller.ts';
import { RouteSecretGateway } from './lib/secret-gateway.ts';
import { StdinSecretValue } from './lib/stdin-secret-value.ts';
import { ExitStatus } from './shell.ts';

/**
 * Vault's `fy` half (§2.3): `fy secret set <name>`, the value read from stdin and never from an argument (S1, S33).
 * `ls`, `rm` and `use` are not declared yet (they come after merge), so the manifest has nothing else to answer.
 */
export default implementCli(manifest, {
  build(ctx) {
    const { client, io } = ctx;
    const exit = new ExitStatus();
    const controller = new SecretController(
      new RouteSecretGateway(client),
      { success: (message: string) => io.out(`${message}\n`) },
      new StdinSecretValue('fy', ctx.readText),
    );
    return { verbs: secretVerbs(controller, io, exit) };
  },
});
