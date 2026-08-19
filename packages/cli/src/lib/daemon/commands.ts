import type { Command } from 'commander';
import type { StateHomeAdoptOptions, StateHomeController } from '../state-home/controller.ts';
import type { DaemonCommandOptions, DaemonController } from './controller.ts';

/**
 * Mounts `fy daemon …` onto the program.
 *
 * Every verb is idempotent and says what it found: `start` on a serving daemon reports that rather
 * than disturbing it, `stop` on a stopped one says so instead of failing.
 *
 * THERE IS NO `snapshot` GROUP, and its absence is the design rather than an omission. `build`,
 * `promote` and `list` managed a content-addressed store of copies of the daemon executable, which
 * asked an operator to learn a second installation model for one file and to promote something before
 * their upgrade took effect. What runs is the daemon this host has installed; upgrading is the package
 * manager's job and `restart` picks it up. Nothing rewrote those verbs into a deprecation stub because
 * a stub is still the concept, still in `--help`, and still a thing to keep working — the one
 * invocation an upgraded host makes says what happened to the store instead.
 *
 * `adopt` belongs to this group rather than a group of its own because the state home is the
 * daemon's: it is the directory `fyd` serves from, and adopting one is something a person does in
 * order to get the daemon running. Its controller is separate because it shares no collaborator with
 * the process-control verbs — it touches one file and never asks whether anything is running.
 */
export function registerDaemonCommands(
  program: Command,
  controller: () => DaemonController,
  stateHome: () => StateHomeController,
): void {
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
    .addHelpText(
      'after',
      `
When run at a terminal on a machine that has no operator password, this offers
to set one after the daemon is up. It is asked once, it can be skipped with
Enter, and nothing about using this machine locally depends on it — what needs
it is pairing another device, which the daemon refuses without one.

Nothing is ever asked when there is no terminal, so a service-managed start at
login is untouched: a unit runs the daemon executable, never this command.`,
    )
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
    .command('which')
    .description('show the installed and currently running daemon identities')
    .option('--json', 'print the machine-readable daemon identities')
    .action(async (flags: DaemonCommandOptions) => {
      await controller().which(flags);
    });

  daemon
    .command('logs')
    .description('print the daemon log')
    .option('-f, --follow', 'keep streaming as the log grows')
    .action(async (flags: DaemonCommandOptions) => {
      await controller().logs(flags);
    });

  daemon
    .command('adopt')
    .description('claim a state home Ferretry created before layout claims existed, after showing what it holds')
    .option('--json', 'print the machine-readable outcome instead of the human summary')
    .action(async (flags: StateHomeAdoptOptions) => {
      await stateHome().adopt(flags);
    });
}
