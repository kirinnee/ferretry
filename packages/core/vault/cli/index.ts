import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { secretVerbs } from './lib/commands.ts';
import { SecretController } from './lib/secret-controller.ts';
import { RouteSecretGateway } from './lib/secret-gateway.ts';
import { StdinSecretValue } from './lib/stdin-secret-value.ts';
import { ExitStatus } from './shell.ts';

/**
 * Vault's `fy` half (§2.3): `fy secret set <name>`, the value read from stdin and never from an argument (S1, S33),
 * `ls` (names and instants), `rm <name>` and `use <command...>` (a command run with secrets in ITS environment).
 * Nothing printed here is a value: a use's output comes back from the daemon already masked.
 */
export default implementCli(manifest, {
  build(ctx) {
    const { client, io } = ctx;
    const exit = new ExitStatus();
    const controller = new SecretController(
      new RouteSecretGateway(client),
      {
        success: (message: string) => io.out(`${message}\n`),
        error: (message: string) => io.err(`${message}\n`),
        setExitCode: (code: number) => exit.setExitCode(code),
        raw: (stream, text) => (stream === 'stdout' ? io.out(text) : io.err(text)),
      },
      new StdinSecretValue('fy', ctx.readText, ctx.promptHidden),
      ctx.env?.PWD,
    );
    return { verbs: secretVerbs(controller, io, exit) };
  },
});
