import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerImportCommands, registerNewCommand } from '../../../src/lib/import/commands.ts';
import type { ImportListOptions, ImportSelectOptions, NewSessionOptions } from '../../../src/lib/import/controller.ts';

function importProgram() {
  const listCalls: ImportListOptions[] = [];
  const selectCalls: ImportSelectOptions[] = [];
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerImportCommands(program, {
    list: async options => void listCalls.push(options),
    select: async options => void selectCalls.push(options),
  });
  return { program, listCalls, selectCalls };
}

function newProgram() {
  const runCalls: NewSessionOptions[] = [];
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerNewCommand(program, { run: async options => void runCalls.push(options) });
  return { program, runCalls };
}

describe('registerImportCommands', () => {
  it('should list with no filters by default', async () => {
    // Arrange
    const { program, listCalls, selectCalls } = importProgram();

    // Act
    await program.parseAsync(['node', 'fy', 'import', 'conversations']);

    // Assert
    should(listCalls).eql([{ json: false }]);
    should(selectCalls).be.empty();
  });

  it('should join a variadic query and pass harness/since through', async () => {
    // Arrange
    const { program, listCalls } = importProgram();

    // Act
    await program.parseAsync([
      'node',
      'fy',
      'import',
      'conversations',
      'login',
      'bug',
      '--harness',
      'claude',
      '--since',
      '7d',
      '--json',
    ]);

    // Assert
    should(listCalls).eql([{ query: 'login bug', harness: 'claude', since: '7d', json: true }]);
  });

  it('should reject an unknown harness', async () => {
    // Arrange
    const { program } = importProgram();

    // Act + Assert
    await should(program.parseAsync(['node', 'fy', 'import', 'conversations', '--harness', 'gemini'])).be.rejected();
  });

  it('should reject a malformed --since before the action ever runs', async () => {
    // Arrange
    const { program, listCalls } = importProgram();

    // Act + Assert
    await should(program.parseAsync(['node', 'fy', 'import', 'conversations', '--since', 'soon'])).be.rejected();
    should(listCalls).be.empty();
  });

  it('should switch to select mode and collect every --select id', async () => {
    // Arrange
    const { program, listCalls, selectCalls } = importProgram();

    // Act
    await program.parseAsync([
      'node',
      'fy',
      'import',
      'conversations',
      '--select',
      'c-1',
      'c-2',
      '--runtime',
      'claude-work',
      '--start',
    ]);

    // Assert
    should(listCalls).be.empty();
    should(selectCalls).eql([{ select: ['c-1', 'c-2'], runtime: 'claude-work', start: true, json: false }]);
  });

  it('should pass select without a runtime through, leaving the refusal to the controller', async () => {
    // Arrange
    const { program, selectCalls } = importProgram();

    // Act
    await program.parseAsync(['node', 'fy', 'import', 'conversations', '--select', 'c-1']);

    // Assert
    should(selectCalls).eql([{ select: ['c-1'], start: false, json: false }]);
  });
});

describe('registerNewCommand', () => {
  it('should default continue to false and pass nothing else when nothing was given', async () => {
    // Arrange
    const { program, runCalls } = newProgram();

    // Act
    await program.parseAsync(['node', 'fy', 'new']);

    // Assert
    should(runCalls).eql([{ continue: false }]);
  });

  it('should join the query and pass every other flag through', async () => {
    // Arrange
    const { program, runCalls } = newProgram();

    // Act
    await program.parseAsync([
      'node',
      'fy',
      'new',
      '--continue',
      'login',
      'bug',
      '--harness',
      'codex',
      '--runtime',
      'codex-work',
      '--since',
      '2h',
    ]);

    // Assert
    should(runCalls).eql([
      { continue: true, query: 'login bug', harness: 'codex', runtime: 'codex-work', since: '2h' },
    ]);
  });

  it('should reject a malformed --since', async () => {
    // Arrange
    const { program } = newProgram();

    // Act + Assert
    await should(program.parseAsync(['node', 'fy', 'new', '--continue', '--since', 'later'])).be.rejected();
  });
});
