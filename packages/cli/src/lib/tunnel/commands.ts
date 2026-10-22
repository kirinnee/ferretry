import type { Command } from 'commander';
import type { TunnelCommandOptions, TunnelController } from './controller.ts';

/**
 * Mounts `fy daemon tunnel …` onto the existing `daemon` command, beside `security`: the Cloudflare
 * tunnel is opt-in per machine, and this is where it is turned on or off.
 */
export function registerTunnelCommands(program: Command, controller: () => TunnelController): void {
  const daemon = program.commands.find(command => command.name() === 'daemon');
  if (daemon === undefined) throw new Error('the daemon command group must be registered before its tunnel verbs');
  const tunnel = daemon
    .command('tunnel')
    .description('turn this machine’s Cloudflare tunnel on or off, or show it')
    .addHelpText(
      'after',
      [
        '',
        'The tunnel is opt-in: a machine runs none until it is turned on, here or in the app under',
        'Settings › Connection. It applies at once, without a restart. Turning it off releases the',
        'tunnel back to the hosted pool.',
      ].join('\n'),
    );

  tunnel
    .command('status', { isDefault: true })
    .description('show whether the tunnel is on, and where it is')
    .option('--json', 'print the protocol document instead of the sentence')
    .action(async (options: TunnelCommandOptions) => {
      await controller().status(options);
    });

  tunnel
    .command('on')
    .description('turn the tunnel on for this machine')
    .action(async () => {
      await controller().on();
    });

  tunnel
    .command('off')
    .description('turn the tunnel off and release it')
    .action(async () => {
      await controller().off();
    });
}
