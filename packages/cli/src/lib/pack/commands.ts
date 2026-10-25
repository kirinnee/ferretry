import type { Command } from 'commander';
import type {
  PackCleanUpOptions,
  PackController,
  PackGuideShowOptions,
  PackRecommendOptions,
  PackWriteOptions,
} from './controller.ts';

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
    .description('the routing prompt and the models that can run a piece of work here now (Pack mode)')
    .argument('[task...]', 'the part to hand to a sub-ferret (echoed back; nothing is matched against it)')
    .option('--json', 'print the payload')
    .action(async (words: string[], options: PackRecommendOptions) => {
      try {
        await controller.recommend(words, options);
      } catch (error) {
        reporter.fail(error);
      }
    });
}

/**
 * Mounts `fy guide` (docs/pack-mode.md): the ONE routing prompt Pack mode picks sub-ferret models with — show
 * it, what the builder is shown, Write it for me (a short-lived ferret writes a whole prompt from a short
 * idea) and Clean up (it rewrites the owner's; a person reviews the diff), accepting the result and undoing that.
 */
export function registerGuideCommand(
  program: Command,
  controller: PackController,
  reporter: PackFailureReporter,
): void {
  const guide = program.command('guide').description('the routing prompt Pack mode picks sub-ferret models with');
  const run =
    <A extends unknown[]>(act: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      try {
        await act(...args);
      } catch (error) {
        reporter.fail(error);
      }
    };
  guide
    .command('show')
    .description('the routing prompt in effect, where it came from, and whether a clean-up can be undone')
    .option('--json', 'print the routing prompt')
    .action(run(async (options: PackGuideShowOptions) => await controller.showGuide(options)));
  guide
    .command('inventory')
    .description('what Clean up is shown: every runtime, its models, readiness and quota, and every model')
    .option('--json', 'print the inventory')
    .action(run(async (options: PackGuideShowOptions) => await controller.showInventory(options)));
  guide
    .command('clean-up')
    .description(
      'have a short-lived ferret rewrite the routing prompt to fit (one model run), then review it as a diff',
    )
    .option('--prompt <text>', 'the rough prompt to clean up (default: the one in effect)')
    .option('--prompt-file <file>', 'read the rough prompt from a file')
    .option('--runtime <runtime>', 'run it on this runtime (default: the ready one with the most quota left)')
    .option('--model <model>', 'run it on this model (default: the runtime’s own)')
    .option('-y, --apply', 'accept the rewrite as soon as it is checked')
    .option('--json', 'print the run and its checked rewrite')
    .action(run(async (options: PackCleanUpOptions) => await controller.cleanUp(options)));
  guide
    .command('write')
    .description('have a short-lived ferret write the routing prompt from a short idea (one model run), then review it')
    .option(
      '--idea <text>',
      'what you want, in your words, up to 4,000 characters ("cheap models for chores, Opus for planning"); optional',
    )
    .option('--runtime <runtime>', 'run it on this runtime (default: the ready one with the most quota left)')
    .option('--model <model>', 'run it on this model (default: the runtime’s own)')
    .option('-y, --apply', 'accept the prompt as soon as it is checked')
    .option('--json', 'print the run and its checked prompt')
    .action(run(async (options: PackWriteOptions) => await controller.write(options)));
  guide
    .command('accept')
    .description('write a builder run’s checked prompt as the routing prompt (undo puts the old one back)')
    .argument('<run>', 'the run id guide clean-up or guide write printed')
    .action(run(async (id: string) => await controller.accept(id)));
  guide
    .command('undo')
    .description('put back the routing prompt the last accepted clean-up replaced')
    .action(run(async () => await controller.undo()));
}
