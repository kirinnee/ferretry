import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerGuideCommand, registerRecommendCommand } from '../../../src/lib/pack/commands.ts';
import type { PackController, PackRecommendOptions } from '../../../src/lib/pack/controller.ts';

function build(failure?: Error) {
  const calls: Array<{ words: readonly string[]; options: PackRecommendOptions }> = [];
  const failures: unknown[] = [];
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const controller = {
    recommend: async (words: readonly string[], options: PackRecommendOptions) => {
      calls.push({ words, options });
      if (failure !== undefined) throw failure;
    },
  } as unknown as PackController;
  registerRecommendCommand(program, controller, { fail: error => void failures.push(error) });
  return { program, calls, failures };
}

describe('registerRecommendCommand', () => {
  it('should pass the task words and no options by default', async () => {
    // Arrange
    const { program, calls } = build();

    // Act
    await program.parseAsync(['node', 'fy', 'recommend', 'rename', 'a', 'helper']);

    // Assert
    should(calls).eql([{ words: ['rename', 'a', 'helper'], options: {} }]);
  });

  it('should pass --json through', async () => {
    // Arrange
    const { program, calls } = build();

    // Act
    await program.parseAsync(['node', 'fy', 'recommend', 'x', '--json']);

    // Assert
    should(calls).eql([{ words: ['x'], options: { json: true } }]);
  });

  it('should ask with no task at all, the task being optional', async () => {
    // Arrange
    const { program, calls } = build();

    // Act
    await program.parseAsync(['node', 'fy', 'recommend']);

    // Assert
    should(calls).eql([{ words: [], options: {} }]);
  });

  it('should no longer know --use-case', async () => {
    // Arrange
    const { program, calls } = build();

    // Act + Assert
    await should(program.parseAsync(['node', 'fy', 'recommend', 'x', '--use-case', 'bulk'])).be.rejected();
    should(calls).be.empty();
  });

  it('should hand a controller failure to the reporter instead of throwing', async () => {
    // Arrange
    const failure = new Error('daemon said no');
    const { program, failures } = build(failure);

    // Act
    await program.parseAsync(['node', 'fy', 'recommend', 'x']);

    // Assert
    should(failures).eql([failure]);
  });
});

describe('registerGuideCommand', () => {
  function guide(failure?: Error) {
    const calls: Array<readonly [string, ...unknown[]]> = [];
    const failures: unknown[] = [];
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const record =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        if (failure !== undefined) throw failure;
      };
    const controller = {
      showGuide: record('show'),
      showInventory: record('inventory'),
      cleanUp: record('clean-up'),
      write: record('write'),
      accept: record('accept'),
      undo: record('undo'),
    } as unknown as PackController;
    registerGuideCommand(program, controller, { fail: error => void failures.push(error) });
    return { program, calls, failures };
  }
  const parse = async (program: Command, ...args: string[]) =>
    await program.parseAsync(['node', 'fy', 'guide', ...args]);

  it('should hand every subcommand its arguments and options', async () => {
    // Arrange
    const { program, calls } = guide();

    // Act
    await parse(program, 'show');
    await parse(program, 'show', '--json');
    await parse(program, 'inventory', '--json');
    await parse(
      program,
      'clean-up',
      '--prompt',
      'Opus first.',
      '--runtime',
      'claude-work',
      '--model',
      'opus',
      '-y',
      '--json',
    );
    await parse(program, 'clean-up', '--prompt-file', 'rough.md', '--apply');
    await parse(program, 'write', '--idea', 'cheap chores', '--runtime', 'claude-work', '-y');
    await parse(program, 'write');
    await parse(program, 'accept', 'run-1');
    await parse(program, 'undo');

    // Assert
    should(calls.map(call => [call[0], ...call.slice(1).filter(arg => !(arg instanceof Command))])).eql([
      ['show', {}],
      ['show', { json: true }],
      ['inventory', { json: true }],
      ['clean-up', { prompt: 'Opus first.', runtime: 'claude-work', model: 'opus', apply: true, json: true }],
      ['clean-up', { promptFile: 'rough.md', apply: true }],
      ['write', { idea: 'cheap chores', runtime: 'claude-work', apply: true }],
      ['write', {}],
      ['accept', 'run-1'],
      ['undo'],
    ]);
  });

  it('should refuse accept without a run before the controller is asked', async () => {
    // Arrange
    const { program, calls } = guide();

    // Act + Assert
    await should(parse(program, 'accept')).be.rejected();
    should(calls).be.empty();
  });

  it('should hand a failure to the reporter', async () => {
    // Arrange
    const failure = new Error('no daemon');
    const { program, failures } = guide(failure);

    // Act
    await parse(program, 'show');
    await parse(program, 'undo');

    // Assert
    should(failures).eql([failure, failure]);
  });
});

describe('the old guide subcommands', () => {
  it('should be gone: suggest, describe, --only, --keep-routing and --prefs', async () => {
    // Arrange
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerGuideCommand(program, {} as unknown as PackController, { fail: () => {} });
    const guide = program.commands.find(command => command.name() === 'guide');

    // Act
    const names = guide?.commands.map(command => command.name());
    const accept = guide?.commands.find(command => command.name() === 'accept');
    const cleanUp = guide?.commands.find(command => command.name() === 'clean-up');
    const write = guide?.commands.find(command => command.name() === 'write');

    // Assert
    should(names).eql(['show', 'inventory', 'clean-up', 'write', 'accept', 'undo']);
    should(accept?.options.map(option => option.long)).eql([]);
    should(cleanUp?.options.map(option => option.long)).eql([
      '--prompt',
      '--prompt-file',
      '--runtime',
      '--model',
      '--apply',
      '--json',
    ]);
    should(write?.options.map(option => option.long)).eql(['--idea', '--runtime', '--model', '--apply', '--json']);
  });
});
