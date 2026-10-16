import type { Command } from 'commander';
import type { LessonCommandOptions, LessonController } from './controller.ts';

/**
 * Mounts `fy lesson suggest` (docs/learning.md): how a running ferret files a lesson for the owner
 * to review, the same act the `lessons_suggest` MCP tool performs.
 */
export function registerLessonCommands(program: Command, controller: LessonController): void {
  const lesson = program.command('lesson').description('file a lesson for the owner to review');

  lesson
    .command('suggest')
    .description('file one lesson as the agent session this runs inside')
    .argument('<rule>', 'one short imperative rule, at most 500 characters')
    .requiredOption('--scope <scope>', 'global (every ferret should follow it) or repo (a fact about this project)')
    .option('--json', 'print the protocol payload instead of the daemon’s sentence')
    .action(async (rule: string, options: LessonCommandOptions & { scope: string }) => {
      await controller.suggest(rule, options.scope, options);
    });
}
