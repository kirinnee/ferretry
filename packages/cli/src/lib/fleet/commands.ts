import type { Command } from 'commander';
import type { FleetRecommendOptions, RecommendController } from './recommend.ts';

/** Mounts `fy fleet recommend`, the one verb the fleet group keeps. */
export function registerFleetCommands(program: Command, controller: RecommendController): void {
  const fleet = program
    .command('fleet')
    .description('which agents suit a piece of work')
    .option('--json', 'print the payload instead of the human rendering');

  fleet
    .command('recommend')
    .description('which agents suit a piece of work, with the alternatives and what was skipped')
    .argument('<task...>', 'what needs doing')
    .option('--json', 'print the payload instead of the human rendering')
    .option('--no-usage', 'skip quota probing; the guide then reports quota inputs as missing')
    .action((words: string[], _flags: unknown, command: Command) =>
      controller.recommend(words, { ...(fleet.opts() as FleetRecommendOptions), ...command.opts() }),
    );
}
