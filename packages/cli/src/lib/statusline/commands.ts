import { STATUSLINE_SUBCOMMAND, STATUSLINE_THEN_OPTION } from '@ferretry/fleet';
import type { Command } from 'commander';
import type { StatuslineController } from './controller.ts';

/**
 * Mounts `fy statusline` onto the program (account-model §8.1.3). Its command line is produced by
 * `claudeStatuslineCommand` in the fleet package and nowhere else, so the two cannot drift.
 */
export function registerStatuslineCommands(program: Command, controller: StatuslineController): void {
  program
    .command(STATUSLINE_SUBCOMMAND)
    .description("record a Claude runtime's usage from its status line, then run your own status line command")
    .option(`${STATUSLINE_THEN_OPTION} <command>`, 'your own statusLine command, run with the same input')
    .action(async (options: { readonly then?: string }) => {
      await controller.run(options.then === undefined ? {} : { own: options.then });
    });
}
