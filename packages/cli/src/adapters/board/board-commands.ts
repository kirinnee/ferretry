import {
  BoardActivityFilterSchema,
  BoardPrStateFilterSchema,
  BoardStateFilterSchema,
  TaskKindSchema,
} from '@ferretry/protocol';
import type { Command } from 'commander';
import type { BoardController, BoardViewFlags } from '../../lib/board/board-controllers';

const choices = (values: readonly string[]): string => values.join(' | ');

/**
 * `fy board`: the project board as text. It owns the `board` group, so U3's `fy board lanes …` mounts onto
 * the command this returns (`registerLaneCommands` finds it by name).
 */
export function registerBoardCommands(program: Command, controller: BoardController): Command {
  return program
    .command('board')
    .description('the project board: every card in its lane, closed ones hidden')
    .option('--project <name|all>', "a project's name or id, or `all`; default: the board of the calling session")
    .option('--ferret <name>', 'only cards this ferret (callsign or session id) owns or is assigned')
    .option('--mine', 'only cards the calling session owns or is assigned')
    .option('--kind <kind>', `only ${choices(TaskKindSchema.options)}`)
    .option('--pr <state>', `only cards whose PR is ${choices(BoardPrStateFilterSchema.options)}`)
    .option('--activity <activity>', `only ${choices(BoardActivityFilterSchema.options)}`)
    .option('--state <state>', `${choices(BoardStateFilterSchema.options)} (default open)`)
    .option('--closed', 'show the closed cards, which are hidden by default')
    .option('--query <text>', 'only cards whose id, title, summary or ask contain this text')
    .option('--session <id>', 'act as this session instead of the ambient FY_SESSION_ID')
    .option('--json', 'print the daemon response as JSON')
    .option('--md', 'render the board as markdown')
    .action(async (options: BoardViewFlags) => {
      await controller.board(options);
    });
}
