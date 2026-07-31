import type { Command } from 'commander';
import type { DaemonCommandOptions, DaemonController } from './controller.ts';

/**
 * Mounts `fy daemon …` onto the program.
 *
 * Every verb is idempotent and says what it found: `start` on a serving daemon reports that rather
 * than disturbing it, `stop` on a stopped one says so instead of failing.
 */
export function registerDaemonCommands(program: Command, controller: () => DaemonController): void {
  const daemon = program.command('daemon').description('manage the daemon process on this host');

  daemon
    .command('install')
    .description('install the user service definition and start the daemon under it')
    .action(async () => {
      await controller().install();
    });

  daemon
    .command('uninstall')
    .description('stop the daemon and remove its user service definition')
    .action(async () => {
      await controller().uninstall();
    });

  daemon
    .command('start')
    .description('start the daemon and wait until it serves')
    .action(async () => {
      await controller().start();
    });

  daemon
    .command('stop')
    .description('stop the daemon and wait until it has released its address')
    .action(async () => {
      await controller().stop();
    });

  daemon
    .command('restart')
    .description('stop the daemon, wait for it to go quiet, then start it again')
    .action(async () => {
      await controller().restart();
    });

  daemon
    .command('status')
    .description('report whether the daemon is serving, and what supervises it')
    .option('--json', 'print the machine-readable status instead of the human summary')
    .action(async (flags: DaemonCommandOptions) => {
      await controller().status(flags);
    });

  daemon
    .command('logs')
    .description('print the daemon log')
    .option('-f, --follow', 'keep streaming as the log grows')
    .action(async (flags: DaemonCommandOptions) => {
      await controller().logs(flags);
    });
}
