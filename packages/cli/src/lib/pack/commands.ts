import type { Command } from 'commander';
import type {
  PackController,
  PackGuideAcceptOptions,
  PackGuideDescribeOptions,
  PackGuideShowOptions,
  PackGuideSuggestOptions,
  PackRecommendOptions,
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

/**
 * Mounts `fy guide` (docs/pack-mode.md): the models guide Pack mode routes with — show it, and the
 * generator: what a builder is shown, a suggestion drafted by a short-lived ferret, accepting it, undoing that,
 * and the owner's description of a model.
 */
export function registerGuideCommand(
  program: Command,
  controller: PackController,
  reporter: PackFailureReporter,
): void {
  const guide = program.command('guide').description('the models guide Pack mode picks sub-ferret models with');
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
    .description('the guide in effect: where it came from, its routing guidance and its use cases')
    .option('--json', 'print the guide')
    .action(run(async (options: PackGuideShowOptions) => await controller.showGuide(options)));
  guide
    .command('inventory')
    .description('what a guide builder is shown: every model, its runtimes here, their readiness and quota')
    .option('--json', 'print the inventory')
    .action(run(async (options: PackGuideShowOptions) => await controller.showInventory(options)));
  guide
    .command('suggest')
    .description('have a short-lived ferret draft a whole guide (one model run), then show it as a diff')
    .option('--runtime <runtime>', 'run the builder on this runtime (default: the ready one with the most quota left)')
    .option('--model <model>', 'run the builder on this model (default: the runtime’s own)')
    .option('--prefs <text>', 'routing preferences for this draft (default: pack.yaml’s routingPreferences)')
    .option('-y, --apply', 'accept the whole draft as soon as it is checked')
    .option('--json', 'print the run and its checked draft')
    .action(run(async (options: PackGuideSuggestOptions) => await controller.suggest(options)));
  guide
    .command('accept')
    .description("write a builder's checked draft into models-guide.yaml, whole or in part (undo puts it back)")
    .argument('<run>', 'the run id guide suggest printed')
    .option('--only <ids>', 'accept only these use cases, comma-separated')
    .option('--keep-routing', 'keep the routing guidance in effect')
    .action(run(async (id: string, options: PackGuideAcceptOptions) => await controller.accept(id, options)));
  guide
    .command('undo')
    .description('put back the guide the last accepted suggestion replaced')
    .action(run(async () => await controller.undo()));
  guide
    .command('describe')
    .description('describe a model in your own words; the guide builder reads it')
    .argument('<model>', 'a model id or label any catalog lists')
    .argument('[text...]', 'what it is good and bad at, what it costs, when to use or avoid it')
    .option('--provider <provider>', 'the catalog, when more than one lists the model')
    .option('--clear', "use the catalog's description again")
    .action(
      run(
        async (model: string, words: string[], options: PackGuideDescribeOptions) =>
          await controller.describe(model, words, options),
      ),
    );
}
