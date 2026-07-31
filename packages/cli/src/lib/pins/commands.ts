import type { Command } from 'commander';
import type { PinCommandOptions, PinController } from './controller.ts';

const SESSION_FLAG = '-s, --session <id>';
const SESSION_HELP = 'target another session (defaults to the session this command runs inside)';
const JSON_FLAG = '--json';
const JSON_HELP = 'print the protocol snapshot instead of the human listing';

/**
 * Mounts `fy pin …` onto the program.
 *
 * `add` is the default verb, so `fy pin remember to rebase` still works the way an agent expects
 * while `ls`/`rm`/`edit` stay explicit. `edit` is new: the protocol has always carried the action
 * but kteam's CLI never exposed it, so a mistyped note could only be removed and re-added.
 */
export function registerPinCommands(program: Command, controller: PinController): void {
  const pin = program
    .command('pin')
    .description('manage a session pin board — the notes and messages worth keeping')
    .option(SESSION_FLAG, SESSION_HELP)
    .option(JSON_FLAG, JSON_HELP);

  const options = (command: Command): PinCommandOptions => ({
    ...(pin.opts() as PinCommandOptions),
    ...(command.opts() as PinCommandOptions),
  });

  pin
    .command('add', { isDefault: true })
    .description('pin a note to the board')
    .argument('<text...>', 'the note to pin')
    .option(SESSION_FLAG, SESSION_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (words: string[], _flags: unknown, command: Command) => {
      await controller.add(words, options(command));
    });

  pin
    .command('ls')
    .alias('list')
    .description('list the pins on the board')
    .option(SESSION_FLAG, SESSION_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (_flags: unknown, command: Command) => {
      await controller.list(options(command));
    });

  pin
    .command('edit')
    .description('replace the text of a note pin')
    .argument('<id>', 'the pin id, or the short id `pin ls` prints')
    .argument('<text...>', 'the replacement note')
    .option(SESSION_FLAG, SESSION_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (id: string, words: string[], _flags: unknown, command: Command) => {
      await controller.edit(id, words, options(command));
    });

  pin
    .command('rm')
    .alias('remove')
    .description('remove a pin from the board')
    .argument('<id>', 'the pin id, or the short id `pin ls` prints')
    .option(SESSION_FLAG, SESSION_HELP)
    .option(JSON_FLAG, JSON_HELP)
    .action(async (id: string, _flags: unknown, command: Command) => {
      await controller.remove(id, options(command));
    });
}
