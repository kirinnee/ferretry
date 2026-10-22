import type { Command } from 'commander';
import type { PackController, PackGuideShowOptions, PackRecommendOptions } from './controller.ts';

/** Reports a failure as one line and an exit code, never a stack trace. */
export interface PackFailureReporter {
  fail(error: unknown): void;
}

/**
 * Mounts `fy recommend` (docs/pack-mode.md). `fy new` — the start it recommends — shares its verb with
 * `fy new --continue` and is mounted with it (`../import/commands.ts`).
 */
export function registerRecommendCommand(
  program: Command,
  controller: PackController,
  reporter: PackFailureReporter,
): void {
  program
    .command('recommend')
    .description('which models can run a piece of work here now, best first (Pack mode)')
    .argument('<task...>', 'the part to hand to a sub-ferret')
    .option('--use-case <id>', 'use this models-guide use case instead of matching the words')
    .option('--json', 'print the payload')
    .action(async (words: string[], options: PackRecommendOptions) => {
      try {
        await controller.recommend(words, options);
      } catch (error) {
        reporter.fail(error);
      }
    });
}

/** Mounts `fy guide` (docs/pack-mode.md): the models guide Pack mode routes with. */
export function registerGuideCommand(
  program: Command,
  controller: PackController,
  reporter: PackFailureReporter,
): void {
  const guide = program.command('guide').description('the models guide Pack mode picks sub-ferret models with');
  guide
    .command('show')
    .description('the guide in effect: where it came from, its routing guidance and its use cases')
    .option('--json', 'print the guide')
    .action(async (options: PackGuideShowOptions) => {
      try {
        await controller.showGuide(options);
      } catch (error) {
        reporter.fail(error);
      }
    });
}
