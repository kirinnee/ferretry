import { DAEMON_CAPABILITIES } from '@ferretry/protocol';
import type { Command } from 'commander';
import type { GrantCommandOptions, GrantController } from './controller.ts';

/**
 * Mounts `fy daemon config …` onto the existing `daemon` command.
 *
 * ONTO THE EXISTING SHAPE, deliberately. `fy daemon` already reads
 * `install|uninstall|start|stop|restart|status|logs`, and inventing a second grammar for the same
 * subject is how a command line stops being learnable. This is one more verb on the noun that
 * already owns the daemon.
 *
 * `list` IS AN ALIAS FOR `ls` EVERYWHERE, because `fy fleet list` failing confusingly is a mistake
 * this repository has already made once.
 *
 * SETUP-TIME-ONLY WOULD BE A TRAP, and that is why this exists at all. Somebody who wants to revoke
 * the UI's ability to change warden settings six months from now must not have to hand-edit a
 * document or re-run an installer. Grants change over the life of a machine.
 */
export function registerGrantCommands(program: Command, controller: () => GrantController): void {
  // The name the program was given, so every example below names the command that actually exists.
  const bin = program.name();
  // The EXISTING `daemon` group, found rather than created. Creating a second one would give
  // commander two commands with one name and silently lose half the verbs; throwing here turns a
  // wiring mistake into a startup failure instead of a command that quietly does not exist.
  const daemon = program.commands.find(command => command.name() === 'daemon');
  if (daemon === undefined) throw new Error('the daemon command group must be registered before its config verbs');
  const config = daemon
    .command('config')
    .description('read and change what a caller NOT on this host may do')
    .addHelpText(
      'after',
      [
        '',
        'THIS COMMAND LINE is ungoverned: it holds the admin token, and somebody who can read that file',
        'already has the machine, so gating it would add friction and no safety. These grants apply to a',
        'paired phone, a browser across the network, a session carried over the relay.',
        '',
        'Two axes per capability:',
        '  use        may it exercise the capability at all',
        '  configure  may it change how the capability behaves on this host',
        '',
        `Capabilities: ${DAEMON_CAPABILITIES.join(', ')}`,
        '',
        'A paired device confirms a dangerous change with a passkey on that device. Turning something ON',
        'is only ever done from this host.',
      ].join('\n'),
    );

  config
    .command('ls', { isDefault: true })
    .alias('list')
    .description('show every capability, both axes, and where each value came from')
    .option('--json', 'print the protocol document instead of the human report')
    .action(async (options: GrantCommandOptions) => {
      await controller().show(options);
    });

  config
    .command('history')
    .alias('log')
    .description('who changed a grant on this machine, and when')
    .option('--json', 'print the protocol document instead of the human listing')
    .action(async (options: GrantCommandOptions) => {
      await controller().history(options);
    });

  config
    .command('set <capability>')
    .description('grant or revoke one capability, by axis')
    .option('--use', 'let a remote caller exercise this capability')
    .option('--no-use', 'stop a remote caller exercising this capability')
    .option('--configure', 'let a remote caller change this capability’s host settings')
    .option('--no-configure', 'stop a remote caller changing this capability’s host settings')
    .addHelpText(
      'after',
      [
        '',
        `  ${bin} daemon config set warden --no-configure`,
        `  ${bin} daemon config set browser --no-use --no-configure`,
        `  ${bin} daemon config set fleet --configure`,
      ].join('\n'),
    )
    .action(async (capability: string, options: GrantCommandOptions) => {
      await controller().set(capability, options);
    });
}
