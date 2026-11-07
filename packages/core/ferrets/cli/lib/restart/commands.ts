import type { Command } from 'commander';
import type { RestartCommandOptions, RestartController } from './controller.ts';

/** Mounts the idle-aware restart as `fy restart`. */
export function registerRestartCommands(program: Command, controller: RestartController): void {
  program
    .command('restart')
    .description(
      'restart ferrets on the same runtime, keeping the conversation; a busy one waits for its next idle moment',
    )
    .argument('[ids...]', 'session ids or callsigns to restart (with none and no flag: show what is out of date)')
    .option('--outdated', 'restart every ferret whose instructions are out of date')
    .option('--all', 'restart every running ferret')
    .option('--cancel', 'clear the restarts that are waiting for a ferret to go idle')
    .option('--request-id <id>', 'stable idempotency key for an explicit retry of this restart')
    .option('--json', 'print the result as JSON')
    .action(async (ids: string[], options: RestartCommandOptions) => {
      await controller.execute(ids, options);
    });
}
