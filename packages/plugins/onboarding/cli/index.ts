import { implementCli, type TerminalIo, type VerbInvocation } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { onboardClient } from './lib/client.ts';
import { OnboardController } from './lib/controller.ts';
import type { OnboardOutput, OnboardPrompt } from './lib/ports.ts';
import { BIN } from './lib/words.ts';

/**
 * A terminal that can also ask a question. GAP(cli-shell): the shell's `TerminalIo` has `out`, `err` and `isTty` and no
 * way to read an answer, so `onboard` asks only when the io it was given can (`ask`); otherwise it asks nothing.
 */
export type AskingIo = TerminalIo & { ask?(message: string): Promise<string> };

const promptOf = (io: AskingIo): OnboardPrompt | undefined =>
  io.isTty && io.ask !== undefined
    ? { ask: message => (io.ask as (message: string) => Promise<string>)(`${message} `) }
    : undefined;

const outputOf = (io: TerminalIo): OnboardOutput => ({
  report: text => io.out(`${text}\n`),
  warn: text => io.err(`${text}\n`),
});

/** A switch is on for `--name`, `--name=true` and the short letter. */
const on = (invocation: VerbInvocation, ...names: readonly string[]): boolean =>
  names.some(name => invocation.options[name] === true || invocation.options[name] === 'true');

/**
 * Onboarding's CLI half: `onboard`, `onboard status`, `onboard reset`. Thin: the flow is `lib/controller.ts`.
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
        'onboard status': invocation => controller().status({ json: on(invocation, 'json') }),
        'onboard reset': () => controller().reset(),
      },
    };
  },
});
