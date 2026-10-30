import type { Command } from 'commander';
import type { InputAnswerOptions, InputCommandOptions, InputController } from './controller.ts';

const SESSION_FLAG = '-s, --session <id>';
const SESSION_HELP = 'the session whose requests these are';
const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol payload instead of the human rendering';

const INPUT_HELP = `The owner's command. A ferret that is stuck at a password, 2FA code or sudo prompt raises a
request instead of asking for the value; you answer it here, or on its card in the app.

  ls                      the requests still waiting, with what each one is typed into
  answer <!A7>            shows what the daemon sees at the target, then reads the value from this
                          terminal with nothing echoed, and types it for the ferret
  cancel <!A7>            declines the request

There is no flag, argument, environment variable or pipe that carries the value: it is typed at the
prompt, sent once, and dropped. A ferret cannot run these commands.
\`answer\` presses Enter for you in a terminal (--no-enter to leave it); an unfamiliar program needs
--trust-program.`;

/** Mounts `fy input ls|answer|cancel`. */
export function registerInputCommands(program: Command, controller: InputController): void {
  const input = program
    .command('input')
    .description('answer a ferret that needs a password or code typed for it')
    .addHelpText('after', `\n${INPUT_HELP}`)
    .option(SESSION_FLAG, SESSION_HELP)
    .option(JSON_FLAG, JSON_HELP);
  const merged = <T extends InputCommandOptions>(command: Command): T => ({
    ...(input.opts() as T),
    ...(command.opts() as T),
  });

  input
    .command('ls')
    .description('list the input requests still waiting')
    .option(SESSION_FLAG, SESSION_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (_options: unknown, command: Command) => {
      await controller.list(merged(command));
    });
  input
    .command('answer')
    .description('type the value for a request, read from this terminal with nothing echoed')
    .argument('<reference>', 'the card, as !A7')
    .option(SESSION_FLAG, SESSION_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .option('--no-enter', 'type it without pressing Enter')
    .option('--enter', 'press Enter after typing (browser fields otherwise stay unsubmitted)')
    .option('--trust-program', 'the program reading the terminal is not one known to ask for secrets; I trust it')
    .action(async (reference: string, _options: unknown, command: Command) => {
      await controller.answer(reference, merged<InputAnswerOptions>(command));
    });
  input
    .command('cancel')
    .description('decline a request')
    .argument('<reference>', 'the card, as !A7')
    .option(SESSION_FLAG, SESSION_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (reference: string, _options: unknown, command: Command) => {
      await controller.cancel(reference, merged(command));
    });
}
