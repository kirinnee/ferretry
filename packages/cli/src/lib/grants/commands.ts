import { DAEMON_CAPABILITIES } from '@ferretry/protocol';
import type { Command } from 'commander';
import type { GrantCommandOptions, GrantController } from './controller.ts';

/**
 * Mounts `fy daemon config …` and `fy daemon password …` onto the existing `daemon` command.
 *
 * ONTO THE EXISTING SHAPE, deliberately. `fy daemon` already reads
 * `install|uninstall|start|stop|restart|status|logs`, and inventing a second grammar for the same
 * subject is how a command line stops being learnable. These are two more verbs on the noun that
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
  // The EXISTING `daemon` group, found rather than created. Creating a second one would give
  // commander two commands with one name and silently lose half the verbs; throwing here turns a
  // wiring mistake into a startup failure instead of a command that quietly does not exist.
  const daemon = program.commands.find(command => command.name() === 'daemon');
  if (daemon === undefined)
    throw new Error('the daemon command group must be registered before its config and password verbs');
  const config = daemon
    .command('config')
    .description('read and change what a caller NOT on this host may do')
    .addHelpText(
      'after',
      [
        '',
        'A caller on this host is ungoverned: somebody at the machine already has the machine, so',
        'gating them would add friction and no safety. These grants apply to a paired phone, a browser',
        'across the network, or a session carried over the relay.',
        '',
        'Two axes per capability:',
        '  use        may it exercise the capability at all',
        '  configure  may it change how the capability behaves on this host',
        '',
        `Capabilities: ${DAEMON_CAPABILITIES.join(', ')}`,
        '',
        'Turning something ON needs the operator password when one is set; turning it OFF never does.',
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
        '  fy daemon config set warden --no-configure',
        '  fy daemon config set browser --no-use --no-configure',
        '',
        'Widening reads the operator password from stdin when this machine has one:',
        '  printf %s "$FY_OPERATOR_PASSWORD" | fy daemon config set fleet --configure',
      ].join('\n'),
    )
    .action(async (capability: string, options: GrantCommandOptions) => {
      await controller().set(capability, options);
    });

  const password = daemon
    .command('password')
    .description('the operator password that gates changes made from off this host')
    .addHelpText(
      'after',
      [
        '',
        'THIS IS NOT THE SYSTEM ROOT PASSWORD. It is a Ferretry operator secret for this daemon; no',
        'command here touches sudo, and none of them can be used to elevate anything on this machine.',
        '',
        'It is stored as an argon2id verifier, never in plaintext, and no route, command or report can',
        'read it back. Set it, or replace it — there is no way to see it.',
      ].join('\n'),
    );

  password
    .command('set')
    .description('set or replace the operator password, reading it from stdin')
    .addHelpText('after', '\n  printf %s "$FY_OPERATOR_PASSWORD" | fy daemon password set\n')
    .action(async () => {
      await controller().setPassword();
    });

  password
    .command('clear')
    .description('remove the operator password, so nothing gates a remote configuration change')
    .action(async () => {
      await controller().clearPassword();
    });
}
