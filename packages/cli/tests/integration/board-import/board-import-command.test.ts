import { describe, it } from 'bun:test';
import type { BoardImportSummary } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerBoardImportCommand } from '../../../src/adapters/board-import/board-import-command';
import type { IBoardImportGateway } from '../../../src/lib/board-import/ports';

const summary: BoardImportSummary = {
  dryRun: false,
  skipped: false,
  sessions: 1,
  imported: 2,
  alreadyImported: 0,
  proposedProjects: [],
  linkedAsks: 0,
  untriagedCards: 0,
  problems: [],
  complete: true,
};

const harness = (program = new Command().exitOverride()) => {
  const asked: boolean[] = [];
  const lines: string[] = [];
  const gateway: IBoardImportGateway = {
    run: dryRun => {
      asked.push(dryRun);
      return Promise.resolve({ ...summary, dryRun });
    },
  };
  registerBoardImportCommand(program, { gateway, io: { success: line => lines.push(line) } });
  return { asked, lines, program };
};

const run = async (program: Command, ...args: string[]) => {
  await program.parseAsync(['bun', 'fy', 'board', 'import', ...args]);
};

describe('the board import command', () => {
  it('should run the import for real by default', async () => {
    const { asked, lines, program } = harness();
    await run(program);
    should(asked).eql([false]);
    should(lines[0]).containEql('Board import finished.');
  });

  it('should only preview with --dry-run', async () => {
    const { asked, lines, program } = harness();
    await run(program, '--dry-run');
    should(asked).eql([true]);
    should(lines[0]).containEql('Dry run');
  });

  it('should print JSON with --json', async () => {
    const { lines, program } = harness();
    await run(program, '--json');
    should(JSON.parse(lines[0] ?? '')).have.property('imported', 2);
  });

  it('should join a board group that already exists instead of making a second one', async () => {
    const existing = new Command().exitOverride();
    existing.command('board');
    const { asked, program } = harness(existing);
    await run(program);
    should(program.commands.filter(command => command.name() === 'board')).have.length(1);
    should(asked).have.length(1);
  });
});
