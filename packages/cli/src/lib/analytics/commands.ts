import type { Command } from 'commander';
import type { AnalyticsCommandOptions, AnalyticsController } from './controller.ts';

const EXAMPLES = `Examples:
  fy analytics                                   every session, ungrouped
  fy analytics 'sum(tokens) by agent'            token spend per agent
  fy analytics 'count by day{status="failed"}'   failures per day`;

/** Mounts `fy analytics` onto the program. The query is variadic so it needs no quoting when simple. */
export function registerAnalyticsCommands(program: Command, controller: AnalyticsController): void {
  program
    .command('analytics')
    .description('query the session analytics index — spend, tokens, duration and outcome rates')
    .argument('[query...]', 'the analytics query; omit it for every session, ungrouped')
    .option('--json', 'print the protocol response instead of the terminal table')
    .addHelpText('after', `\n${EXAMPLES}`)
    .action(async (words: string[], options: AnalyticsCommandOptions) => {
      await controller.query(words, options);
    });
}
