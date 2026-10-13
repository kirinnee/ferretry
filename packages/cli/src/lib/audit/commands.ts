import type { Command } from 'commander';
import type { AuditCommandOptions, AuditController } from './controller.ts';

/**
 * Mounts `fy daemon audit` onto the existing `daemon` command.
 *
 * Onto the existing group for the reason `config` and `password` are: the security log belongs to
 * the daemon, and a second noun for it would be a second grammar. Throwing when the group is missing
 * turns a wiring mistake into a startup failure instead of a verb that quietly does not exist.
 */
export function registerAuditCommands(program: Command, controller: () => AuditController): void {
  const daemon = program.commands.find(command => command.name() === 'daemon');
  if (daemon === undefined) throw new Error('the daemon command group must be registered before its audit verb');
  daemon
    .command('audit')
    .description('show the security log: who was paired, removed or refused, and what was done, newest first')
    .option('--limit <n>', 'how many records to show (at most 200)')
    .option('--json', 'print the protocol document instead of the human listing')
    .action(async (options: AuditCommandOptions) => {
      await controller().show(options);
    });
}
