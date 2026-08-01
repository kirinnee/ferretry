import type { Command } from 'commander';
import type { MigrationCommandOptions, MigrationController } from './controller.ts';

/** Mounts the daemon-gated session migration as `fy migrate`. */
export function registerMigrationCommands(program: Command, controller: MigrationController): void {
  program
    .command('migrate')
    .description('continue a session on another same-kind fleet account')
    .argument('<id>', 'session id or callsign')
    .requiredOption('-a, --agent <agent>', 'the fleet account to move the session onto')
    .option('--model <model>', "override the model; defaults to the target account's configured model")
    .option(
      '--allow-context-downgrade',
      'accept a target context window smaller than the current one (the daemon otherwise refuses)',
    )
    .option('--request-id <id>', 'stable idempotency key for an explicit retry of this migration')
    .option('--json', 'print the migrated session as JSON')
    .action(async (id: string, options: MigrationCommandOptions) => {
      await controller.execute(id, options);
    });
}
