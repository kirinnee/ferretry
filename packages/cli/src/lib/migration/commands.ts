import type { Command } from 'commander';
import type { MigrationCommandOptions, MigrationController } from './controller.ts';

/** Mounts the daemon-gated session migration as `fy migrate`. */
export function registerMigrationCommands(program: Command, controller: MigrationController): void {
  program
    .command('migrate')
    .description('continue a session on another runtime (another harness only with --convert)')
    .argument('<id>', 'session id or callsign')
    .requiredOption('-a, --agent <agent>', 'the runtime to move the session onto')
    .option('--model <model>', "override the model; defaults to the target account's configured model")
    .option(
      '--allow-context-downgrade',
      'accept a target context window smaller than the current one (the daemon otherwise refuses)',
    )
    .option(
      '--force-inflight',
      'go ahead even though the daemon could not show that what the agent is running is safe to stop (the daemon otherwise refuses; the move is journalled)',
    )
    .option(
      '--conversation <choice>',
      'resume (default) continues the conversation the session is on; fresh starts a new one; previous goes back to the one an earlier Restart left behind; convert rewrites it for the other harness',
    )
    .option(
      '--convert',
      'move onto a runtime of the OTHER harness (Claude ↔ Codex) by converting the conversation; same as --conversation convert',
    )
    .option('--preview', 'with --convert: show what the conversion would carry and change nothing')
    .option('--request-id <id>', 'stable idempotency key for an explicit retry of this migration')
    .option('--json', 'print the migrated session as JSON')
    .action(async (id: string, options: MigrationCommandOptions) => {
      await controller.execute(id, options);
    });
}
