import type { Command } from 'commander';
import type { SecurityCommandOptions, SecurityController } from './controller.ts';

/**
 * Mounts `fy daemon security …` onto the existing `daemon` command, beside `config`: grants say what
 * a remote caller may DO, these say how long its confirmations and pairings LAST.
 */
export function registerSecurityCommands(program: Command, controller: () => SecurityController): void {
  const bin = program.name();
  const daemon = program.commands.find(command => command.name() === 'daemon');
  if (daemon === undefined) throw new Error('the daemon command group must be registered before its security verbs');
  const security = daemon
    .command('security')
    .description('read and change this machine’s security settings')
    .addHelpText(
      'after',
      [
        '',
        'Every setting has a default and hard bounds; a value outside them is refused, never clamped.',
        'A paired device may only TIGHTEN a setting, with a passkey confirmation. Loosening one is done',
        'here, at the machine.',
      ].join('\n'),
    );

  security
    .command('show', { isDefault: true })
    .description('show every setting, its bounds and where the values came from')
    .option('--json', 'print the protocol document instead of the human report')
    .action(async (options: SecurityCommandOptions) => {
      await controller().show(options);
    });

  security
    .command('set <field> <value>')
    .description('change one setting')
    .addHelpText(
      'after',
      [
        '',
        `  ${bin} daemon security set unlockValidityHours 4`,
        `  ${bin} daemon security set stepUpOnActions on`,
        `  ${bin} daemon security set unlockOnOpen off`,
        `  ${bin} daemon security set idleExpiryDays 14`,
      ].join('\n'),
    )
    .action(async (field: string, value: string) => {
      await controller().set(field, value);
    });
}
