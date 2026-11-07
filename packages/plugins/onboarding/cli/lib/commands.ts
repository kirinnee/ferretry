import type { Command } from 'commander';
import type { OnboardController, SetupOptions } from './controller.ts';

/**
 * Mounts `fy setup` onto the program: the one command after installing.
 *
 * TOP-LEVEL, NOT `daemon setup`. That verb already exists and answers a different question — which of
 * your Claude Code and Codex setups to bring in — and this one is the step before it: is the daemon
 * installed, running, current and reachable. `fy setup` names `daemon setup` as a next step when the
 * machine has no runtime yet, so the two read as a sequence rather than as two spellings.
 */
export function registerOnboardCommands(program: Command, controller: () => OnboardController): void {
  const bin = program.name();
  program
    .command('setup')
    .description('finish installing: start the daemon as a user service, check it, then pair your phone')
    .option('-y, --yes', 'install and start the daemon without asking; required when not on a terminal')
    .option('--json', 'print a machine-readable summary instead of the report (never a pairing code)')
    .option('--check', 'change nothing: report what is there and what setup would do')
    .addHelpText(
      'after',
      `
Safe to run again: a daemon already running under its service manager is left
alone. It installs the user service (launchd on macOS, systemd on Linux), checks
the daemon's health and version, says whether an update is out and whether your
phone can reach this computer from another network, then lists what to do next.

It never updates and never restarts a running daemon. Update with
\`${bin} daemon update\` or the app's Update button.

At a terminal it ends by offering the pairing QR. With --yes, --json or no
terminal it names \`${bin} pair\` instead, so the code never lands in a log or an
agent's transcript.

Exit status: 0 ready, 1 not running, 2 waiting for you (no terminal and no
--yes, or you said no).`,
    )
    .action(async (flags: SetupOptions) => {
      await controller().setup(flags);
    });
}
