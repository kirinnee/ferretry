import { implementCli, type TerminalIo, type VerbInvocation } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { onboardClient } from './lib/client.ts';
import { OnboardController } from './lib/controller.ts';
import type { OnboardOutput, OnboardPrompt } from './lib/ports.ts';
import { runDaemonSetup } from './lib/setup.ts';
import { BIN } from './lib/words.ts';

/** A question is asked only where the shell's terminal can ask one: stdin and stdout both a terminal (never for a secret). */
const promptOf = (io: TerminalIo): OnboardPrompt | undefined =>
  io.isTty && io.ask !== undefined
    ? { ask: message => (io.ask as (message: string) => Promise<string>)(message) }
    : undefined;

const outputOf = (io: TerminalIo): OnboardOutput => ({
  report: text => io.out(`${text}\n`),
  warn: text => io.err(`${text}\n`),
});

/** A switch is on for `--name`, `--name=true` and the short letter. */
const on = (invocation: VerbInvocation, ...names: readonly string[]): boolean =>
  names.some(name => invocation.options[name] === true || invocation.options[name] === 'true');

/**
 * Onboarding's CLI half: `onboard`, `onboard status`, `onboard reset` (`lib/controller.ts`) and `daemon setup` (`lib/setup.ts`). Thin.
 */
export default implementCli(manifest, {
  build: ({ client, io }) => {
    const controller = (): OnboardController =>
      new OnboardController({ client: onboardClient(client), prompt: promptOf(io), out: outputOf(io), bin: BIN });
    return {
      verbs: {
        onboard: invocation =>
          controller().run({
            yes: on(invocation, 'yes', 'y'),
            json: on(invocation, 'json'),
            check: on(invocation, 'check'),
          }),
        'daemon setup': async invocation =>
          runDaemonSetup(
            { client, prompt: promptOf(io), out: outputOf(io), bin: BIN },
            { dryRun: on(invocation, 'dry-run'), json: on(invocation, 'json') },
          ),
        'onboard status': invocation => controller().status({ json: on(invocation, 'json') }),
        'onboard reset': () => controller().reset(),
      },
    };
  },
});
