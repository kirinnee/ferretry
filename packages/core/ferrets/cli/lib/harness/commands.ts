import type { Command } from 'commander';
import type { HarnessController } from './controller.ts';

/** Mounts `fy harness status` and `fy harness update` (docs/updating.md › "Updating Claude Code and Codex"). */
export function registerHarnessCommands(program: Command, controller: HarnessController): void {
  const harness = program
    .command('harness')
    .description(
      'the agent CLIs (Claude Code, Codex) this machine runs: where they are, their versions, updating them',
    );
  harness
    .command('status')
    .description('where each agent CLI is, how it was installed, its version, and whether Ferretry verified it')
    .option('--json', 'print the protocol payload instead of the human rendering')
    .action(async options => {
      await controller.status(options);
    });
  harness
    .command('update')
    .description('update claude, codex, or both, with the command for how each was installed')
    .argument('[harness]', 'claude or codex; both when omitted')
    .option('--to <version>', 'install this version, or "verified" for the one Ferretry verified')
    .option('--yes', 'do not ask before updating')
    .option('--allow-unverified', 'install a version Ferretry has not verified yet (--yes never implies this)')
    .action(async (name: string | undefined, options) => {
      await controller.update(name, options);
    });
}
