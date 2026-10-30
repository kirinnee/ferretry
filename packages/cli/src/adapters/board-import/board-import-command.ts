import type { Command } from 'commander';
import { BoardImportController } from '../../lib/board-import/import-controller';
import type { IBoardImportGateway, IBoardImportOutput } from '../../lib/board-import/ports';

export interface BoardImportCommandDependencies {
  readonly gateway: IBoardImportGateway;
  readonly io: IBoardImportOutput;
}

interface BoardImportOptions {
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

/** Adds `import` to the `board` group, creating the group when this registers first. */
export function registerBoardImportCommand(program: Command, dependencies: BoardImportCommandDependencies): Command {
  const controller = new BoardImportController(dependencies.gateway, dependencies.io);
  const board =
    program.commands.find(command => command.name() === 'board') ??
    program.command('board').description('the project board');
  return board
    .command('import')
    .description(
      'turn the old per-session task files into cards on the project boards (the daemon also does this once)',
    )
    .option('--dry-run', 'say what would happen and change nothing')
    .option('--json', 'print the daemon response as JSON')
    .action(async (_options: unknown, command: Command) => {
      // `fy board` owns `--json` as well, so commander gives it the flag: read both, this verb's winning.
      const options: BoardImportOptions = { ...board.opts(), ...command.opts() };
      await controller.run({ dryRun: options.dryRun === true, json: options.json === true });
    });
}
