import type { Command } from 'commander';
import type { ScratchController } from './controller.ts';

/** Mounts the scratch reclamation surface as `fy gc`. */
export function registerScratchCommands(program: Command, controller: ScratchController): void {
  program
    .command('gc')
    .description('reclaim agent scratch from sessions terminal past the TTL (daemon data is never touched)')
    .option('--dry-run', 'print what would be freed and why, without deleting anything')
    .option('--limit <count>', 'sessions to consider in a dry run', Number, 20)
    .option('--json', 'print the protocol payload instead of the human rendering')
    .action(async options => {
      await controller.execute(options);
    });
}
