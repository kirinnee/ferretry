import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerImportCommands, registerNewCommand } from '../../../src/lib/import/commands.ts';
import type {
  ImportKeepOptions,
  ImportListOptions,
  ImportSelectOptions,
  NewSessionOptions,
} from '../../../src/lib/import/controller.ts';
import type { PackNewOptions } from '../../../src/lib/pack/controller.ts';

function importProgram() {
  const listCalls: ImportListOptions[] = [];
  const selectCalls: ImportSelectOptions[] = [];
  const keepCalls: ImportKeepOptions[] = [];
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerImportCommands(program, {
    list: async options => void listCalls.push(options),
    select: async options => void selectCalls.push(options),
    keep: async options => void keepCalls.push(options),
  });
  return { program, listCalls, selectCalls, keepCalls };
}

function newProgram() {
  const runCalls: NewSessionOptions[] = [];
  const freshCalls: Array<{ words: readonly string[]; options: PackNewOptions }> = [];
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerNewCommand(
    program,
    { run: async options => void runCalls.push(options) },
    { newChild: async (words, options) => void freshCalls.push({ words, options }) },
  );
  return { program, runCalls, freshCalls };
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

describe('registerImportCommands keep mode', () => {
  it('should keep everything with --all', async () => {
    const { program, keepCalls, listCalls } = importProgram();
    await program.parseAsync(['node', 'fy', 'import', 'conversations', '--all', '--runtime', 'claude-work']);
    should(keepCalls).eql([{ all: true, runtime: 'claude-work', json: false }]);
    should(listCalls).be.empty();
  });

  it('should keep a window when --since comes with --runtime', async () => {
    const { program, keepCalls } = importProgram();
    await program.parseAsync([
      'node',
      'fy',
      'import',
      'conversations',
      '--since',
      '7d',
      '--runtime',
      'c',
      '--harness',
      'claude',
    ]);
    should(keepCalls).eql([{ since: '7d', runtime: 'c', harness: 'claude', json: false }]);
  });

  it('should still list when --since stands alone', async () => {
    const { program, keepCalls, listCalls } = importProgram();
    await program.parseAsync(['node', 'fy', 'import', 'conversations', '--since', '7d']);
    should(keepCalls).be.empty();
    should(listCalls).eql([{ since: '7d', json: false }]);
  });
});

describe('registerNewCommand', () => {
  it('should default continue to false and pass nothing else when nothing was given', async () => {
    // Arrange
    const { program, runCalls } = newProgram();

    // Act
    await program.parseAsync(['node', 'fy', 'new', '--continue']);

    // Assert
    should(runCalls).eql([{ continue: true }]);
  });

  it('should join the query and pass every other flag through', async () => {
    // Arrange
    const { program, runCalls, freshCalls } = newProgram();

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
    should(freshCalls).be.empty();
  });

  it('should reject a malformed --since', async () => {
    // Arrange
    const { program } = newProgram();

    // Act + Assert
    await should(program.parseAsync(['node', 'fy', 'new', '--continue', '--since', 'later'])).be.rejected();
  });

  it('should hand a start without --continue to the fresh handler with only the Pack options', async () => {
    // Arrange
    const { program, runCalls, freshCalls } = newProgram();

    // Act
    await program.parseAsync([
      'node',
      'fy',
      'new',
      'rename',
      'the',
      'helper',
      '--runtime',
      'claude-work',
      '--model',
      'opus',
      '--effort',
      'high',
      '--cwd',
      '/work',
      '--name',
      'Rename Helper',
      '--mode',
      'interactive',
      '--prompt-file',
      'brief.md',
      '--json',
      '--harness',
      'codex',
      '--since',
      '2h',
    ]);

    // Assert — the continue-only flags never reach the Pack path.
    should(runCalls).be.empty();
    should(freshCalls).eql([
      {
        words: ['rename', 'the', 'helper'],
        options: {
          runtime: 'claude-work',
          model: 'opus',
          effort: 'high',
          cwd: '/work',
          name: 'Rename Helper',
          mode: 'interactive',
          promptFile: 'brief.md',
          json: true,
        },
      },
    ]);
  });

  it('should pass --auto to the fresh handler', async () => {
    // Arrange
    const { program, freshCalls } = newProgram();

    // Act
    await program.parseAsync(['node', 'fy', 'new', '--auto', 'do it']);

    // Assert
    should(freshCalls).eql([{ words: ['do it'], options: { auto: true } }]);
  });

  it('should refuse a mode that is neither auto nor interactive', async () => {
    // Arrange
    const { program } = newProgram();

    // Act + Assert
    await should(program.parseAsync(['node', 'fy', 'new', '--mode', 'wild', 'x'])).be.rejected();
  });

  it('should keep the old path for a bare new when no fresh handler is mounted', async () => {
    // Arrange
    const runCalls: NewSessionOptions[] = [];
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerNewCommand(program, { run: async options => void runCalls.push(options) });

    // Act
    await program.parseAsync(['node', 'fy', 'new']);

    // Assert
    should(runCalls).eql([{ continue: false }]);
  });
});
