import type { Command } from 'commander';
import type { ProfileCommandOptions, ProfileController } from './controller.ts';

/**
 * Mounts `fy daemon profile` onto the existing `daemon` group, for the reason `audit` is there: the
 * profile is of the daemon, and a second noun for it would be a second grammar.
 */
export function registerProfileCommands(program: Command, controller: () => ProfileController): void {
  const daemon = program.commands.find(command => command.name() === 'daemon');
  if (daemon === undefined) throw new Error('the daemon command group must be registered before its profile verb');
  daemon
    .command('profile')
    .description(
      'measure what the daemon spends its time on for a few seconds: CPU, event-loop stalls, hot code, child processes, timers, routes and files — a report safe to share',
    )
    .option('--seconds <n>', 'how long to measure (5 to 300; default 30)')
    .option(
      '--trace-syscalls',
      'also trace the daemon’s system calls from outside (strace on Linux, sudo fs_usage on macOS)',
    )
    .option('--out <file>', 'also write the full report as JSON to this file, to send')
    .option('--json', 'print the protocol document instead of the readable report')
    .action(async (options: ProfileCommandOptions) => {
      await controller().run(options);
    });
}
