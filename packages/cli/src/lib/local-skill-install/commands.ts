import type { Command } from 'commander';
import type { LocalSkillInstallController } from './controller.ts';

const JSON_HELP = 'print the protocol payload instead of the human rendering';

/** A verb's own options over the shared `skill` command's. */
const merged = <T>(command: Command): T => ({ ...(command.parent?.opts() ?? {}), ...command.opts() }) as T;

/** Mounts `fy skill install | installs | uninstall`, making the shared `skill` command when absent. */
export function registerLocalSkillInstallCommands(program: Command, controller: LocalSkillInstallController): void {
  const skill =
    program.commands.find(command => command.name() === 'skill') ??
    program.command('skill').description('skills on this machine');
  if (!skill.options.some(option => option.long === '--json')) skill.option('--json', JSON_HELP);
  skill
    .command('install')
    .description('copy one skill from another account or project on this machine, after you review all of it')
    .requiredOption('--from <path>', 'the skill folder (or its SKILL.md) as the skills inventory lists it')
    .requiredOption('--to <scope>', 'project or runtime')
    .option('--project <root>', 'the project folder it goes into (--to project)')
    .option('--harness <harness>', 'claude or codex: which agent CLI the project is for')
    .option('--runtime <name>', 'the runtime it goes into (--to runtime)')
    .option('--profile <name>', 'the runtime profile that gets it')
    .option('--yes', 'do not ask before copying')
    .option('--json', JSON_HELP)
    .action(async (_flags: unknown, command: Command) => {
      await controller.install(merged(command));
    });
  skill
    .command('installs')
    .description('list the skills copied from this machine, and where')
    .option('--json', JSON_HELP)
    .action(async (_flags: unknown, command: Command) => {
      await controller.installs(merged(command));
    });
  skill
    .command('uninstall')
    .description('remove one copy, and only the files it wrote')
    .argument('<installId>', 'an install id from "skill installs"')
    .option('--yes', 'do not ask before removing')
    .option('--json', JSON_HELP)
    .action(async (installId: string, _flags: unknown, command: Command) => {
      await controller.uninstall(installId, merged(command));
    });
}
