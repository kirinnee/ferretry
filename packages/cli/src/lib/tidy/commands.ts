import type { Command } from 'commander';
import type { TidyController, TidyFlags } from './controller';

/** `fy tidy`: the ferret's one-shot clean-up of its own cards and work-tracking agenda items. */
export function registerTidyCommands(program: Command, controller: TidyController): Command {
  return program
    .command('tidy')
    .description(
      'drop your own cards nobody asked for and close your own agenda items that only track work (dry run unless --yes)',
    )
    .option('--yes', 'do it: drop the cards and close the items listed')
    .option('--reason <why>', 'the reason written on every card dropped and item closed')
    .option('--session <id>', 'act as this session instead of the ambient FY_SESSION_ID')
    .option('--json', 'print the plan (and, with --yes, the result) as JSON')
    .action(async (options: TidyFlags) => {
      await controller.tidy(options);
    });
}
