import { describe, it } from 'bun:test';
import type {
  BoardProjectId,
  BoardProjectsResponse,
  BoardQueryInput,
  BoardResponse,
  BoardTaskResponse,
  LaneSetActionRequest,
} from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerBoardCommands } from '../../../src/adapters/board/board-commands';
import { registerBoardImportCommand } from '../../../src/adapters/board-import/board-import-command';
import { registerLaneCommands } from '../../../src/adapters/board-lanes/lane-commands';
import { BoardController } from '../../../src/lib/board/board-controllers';
import type { IBoardGateway } from '../../../src/lib/board/ports';
import type { ILaneGateway } from '../../../src/lib/board-lanes/ports';
import { laneSet, project } from '../board-lanes/fixtures';
import { boardResponse, FERRETRY_ID, listing, taskResponse } from './fixtures';

const OTHER_ID = '6c0e1f52-8d47-4d6a-9a31-0d2f1b7e4c55' as BoardProjectId;

/** Two real boards and the caller on neither, which is how `fy board lanes show` failed before. */
const boards: BoardProjectsResponse = listing({
  projects: [
    ...listing().projects,
    project({ id: OTHER_ID, name: 'Dotfiles', path: '/work/dotfiles', laneSet: laneSet({ projectId: OTHER_ID }) }),
  ],
  current: null,
});

/**
 * The whole `board` group, registered in the composition root's order (`fy.ts`): `board` first with its
 * own `--project`, `--json` and `--session`, then `lanes` and `import` mounted onto it.
 */
function tree() {
  const queried: BoardQueryInput[] = [];
  const shown: BoardProjectId[] = [];
  const changed: { projectId: BoardProjectId; request: LaneSetActionRequest }[] = [];
  const imported: boolean[] = [];
  const lines: string[] = [];
  const io = { success: (line: string) => lines.push(line), report: (line: string) => lines.push(line) };
  const boardGateway: IBoardGateway = {
    board: (query): Promise<BoardResponse> => {
      queried.push(query);
      return Promise.resolve(boardResponse());
    },
    task: (): Promise<BoardTaskResponse> => Promise.resolve(taskResponse()),
    create: () => Promise.resolve(taskResponse()),
    act: () => Promise.resolve(taskResponse()),
    skip: () => Promise.reject(new Error('not used')),
    projects: () => Promise.resolve(boards),
    sessions: () => Promise.resolve([]),
  };
  const laneGateway: ILaneGateway = {
    projects: () => Promise.resolve(boards),
    project: projectId => {
      shown.push(projectId);
      return Promise.resolve(boards.projects.find(each => each.id === projectId) ?? project());
    },
    change: (projectId, request) => {
      changed.push({ projectId, request });
      return Promise.resolve({ laneSet: laneSet({ projectId, version: 4 }), agenda: 'raised' });
    },
  };
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const controller = new BoardController({
    gateway: boardGateway,
    output: { ...io, diagnostic: () => {} },
    files: { readText: () => Promise.reject(new Error('not used')) },
    binary: 'fy',
    environmentSessionId: undefined,
  });
  registerBoardCommands(program, controller);
  registerLaneCommands(program, { gateway: laneGateway, io, binaryName: 'fy' });
  registerBoardImportCommand(program, {
    gateway: {
      run: dryRun => {
        imported.push(dryRun);
        return Promise.reject(new Error('stop after recording the flag'));
      },
    },
    io,
  });
  const run = async (...argv: string[]) => void (await program.parseAsync(['bun', 'fy', ...argv]));
  return { changed, imported, lines, queried, run, shown };
}

describe('the board command tree', () => {
  it('should give `board lanes show --project <name>` the named board, not the board of the caller', async () => {
    const { run, shown } = tree();
    await run('board', 'lanes', 'show', '--project', 'ferretry');
    should(shown).eql([FERRETRY_ID]);
  });

  it('should take a project id after the verb', async () => {
    const { run, shown } = tree();
    await run('board', 'lanes', 'show', '--project', OTHER_ID);
    should(shown).eql([OTHER_ID]);
  });

  it('should take --project written before the lanes verb as well', async () => {
    const { run, shown } = tree();
    await run('board', '--project', 'Dotfiles', 'lanes', 'show');
    should(shown).eql([OTHER_ID]);
  });

  it('should honour --json after the lanes verb', async () => {
    const { lines, run } = tree();
    await run('board', 'lanes', 'show', '--project', 'ferretry', '--json');
    should(JSON.parse(lines[0] ?? '')).have.property('id', FERRETRY_ID);
  });

  it('should propose and edit on the board --project names', async () => {
    const { changed, run } = tree();
    await run('board', 'lanes', 'propose', '--template', 'pr', '--project', 'dotfiles');
    await run('board', 'lanes', 'edit', '--rename', 'review=look', '--project', FERRETRY_ID);
    should(changed.map(change => [change.projectId, change.request.action])).eql([
      [OTHER_ID, 'propose'],
      [FERRETRY_ID, 'edit'],
    ]);
  });

  it('should still refuse a lanes verb with no project and no board of its own', async () => {
    const { run } = tree();
    await should(run('board', 'lanes', 'show')).be.rejectedWith(/say which project/u);
  });

  it('should still read every project for a bare `board --project all`', async () => {
    const { queried, run } = tree();
    await run('board', '--project', 'all');
    should(queried).have.length(1);
    should(queried[0]).not.have.property('project');
  });

  it('should still scope `board --project <name>` to that board', async () => {
    const { queried, run } = tree();
    await run('board', '--project', 'dotfiles');
    should(queried[0]).have.property('project', OTHER_ID);
  });

  it('should pass --dry-run and --json to `board import`', async () => {
    const { imported, run } = tree();
    await should(run('board', 'import', '--dry-run', '--json')).be.rejectedWith(/stop after recording/u);
    should(imported).eql([true]);
  });
});
