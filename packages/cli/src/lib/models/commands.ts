import type { Command } from 'commander';
import type { ModelsController, ModelsListOptions } from './controller.ts';

/** Mounts `fy models list` and `fy models refresh` (docs/model-catalog.md). */
export function registerModelsCommands(program: Command, controller: ModelsController): void {
  const models = program.command('models').description('the model catalogs this machine offers logins');

  models
    .command('list')
    .description('every model catalog in effect, where it came from, and its models by tier')
    .option('--login <id>', 'only the catalog this login reads')
    .option('--json', 'print the protocol payload instead of the list')
    .action(async (options: ModelsListOptions) => {
      await controller.list(options);
    });

  models
    .command('refresh')
    .description('check now for a newer published model catalog')
    .option('--json', 'print the protocol payload instead of the sentence')
    .action(async (options: { readonly json?: boolean }) => {
      await controller.refresh(options);
    });
}
