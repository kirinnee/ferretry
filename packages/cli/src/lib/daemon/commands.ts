import type { Command } from 'commander';
import type { StateHomeAdoptOptions, StateHomeController } from '../state-home/controller.ts';
import type { DaemonCommandOptions, DaemonController, DaemonResetOptions } from './controller.ts';

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
 *
 * `reset` IS A VERB HERE RATHER THAN A TOP-LEVEL `reset` OR `wipe`, and the choice is the same one
 * `config` and `password` already made when they mounted onto this noun. What it resets is the
 * daemon — its state home, its logs, its configuration, the artifacts this client keeps for it — and
 * it stops the daemon to do it, so it is serialized by the same lifecycle claims as `stop` and
 * `restart` and shares their collaborators. A top-level `reset` would read as though it reset the
 * client, would sit beside nouns rather than beneath the one it belongs to, and would be a second
 * grammar for one verb. There is no `wipe` alias either: two spellings for an irreversible act is two
 * things to search for when somebody is trying to work out what a colleague ran.
 *
 * IT TAKES NO `--json`, and that is the one place it departs from its siblings. `status`, `which` and
 * `adopt` report, so a machine consumes their answer. `reset` destroys, and its output exists to be
 * read by the person deciding — a second rendering of it would mean the one that mattered was the one
 * nobody read. A script passes `--yes` and reads the exit code, which is the whole contract it can act
 * on.
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
    .command('reset')
    .description('stop the daemon and remove ALL of its persistent data on this host')
    .option('-y, --yes', 'skip the typed confirmation; required when not on a terminal')
    .addHelpText(
      'after',
      `
This is the whole installation, not a cache. It removes both trees a Ferretry
installation occupies — the state home, and the client-owned artifacts under
XDG_STATE_HOME — so the configuration, the fleet, every session and transcript,
every stored secret, every paired device and the operator password all go.
Doing it by hand misses the second tree, which is where an obsolete pinned
daemon executable hides, and leaves the machine running that instead.

What survives: the installed executables, any user service definition, and
everything outside those two paths. Nothing else is touched, and no backup is
taken — restoring is not something this can offer.

It prints every path, its size, and how many secrets, devices and sessions are
about to go BEFORE it asks. Read that; those counts are not available anywhere
else. It never asks for the operator password: forgetting the password is one of
the reasons to run this, so requiring it would close the door it exists to open.

Afterwards, \`daemon start\` comes up on a clean slate and offers to set a new
operator password, exactly as a fresh install does.`,
    )
    .action(async (flags: DaemonResetOptions) => {
      await controller().reset(flags);
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
