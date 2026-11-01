import { WorkKindSchema } from '@ferretry/protocol';
import type { Command } from 'commander';
import type { WorkSearchController, WorkSearchFlags } from './controller';

/** `fy search`: one search over the board's cards and the agenda's items. */
export function registerWorkSearchCommands(program: Command, controller: WorkSearchController): Command {
  return program
    .command('search')
    .description("find cards and agenda items by what they say, across every project and ferret's ledger")
    .argument('<text...>', 'words to look for, or an id like F303 / A3')
    .option('--kind <kind>', `only ${WorkKindSchema.options.join(' | ')}`)
    .option('--open', 'only work still to do')
    .option('--project <name>', "only this project's cards (agenda items are kept)")
    .option('--limit <n>', 'at most this many hits (default 20)')
    .option('--session <id>', 'act as this session instead of the ambient FY_SESSION_ID')
    .option('--json', 'print the daemon response as JSON')
    .action(async (words: string[], options: WorkSearchFlags) => {
      await controller.search(words, options);
    });
}
