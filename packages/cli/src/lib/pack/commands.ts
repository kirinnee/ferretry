import type { Command } from 'commander';
import type { PackController, PackRecommendOptions } from './controller.ts';

/** Reports a failure as one line and an exit code, never a stack trace. */
export interface PackFailureReporter {
  fail(error: unknown): void;
}

/**
 * Mounts `fy recommend` (docs/pack-mode.md). `fy new` — the start it recommends — shares its verb with
 * `fy new --continue` and is mounted with it (`../import/commands.ts`).
 */
export function registerRecommendCommand(program: Command, controller: PackController, reporter: PackFailureReporter): void {
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
