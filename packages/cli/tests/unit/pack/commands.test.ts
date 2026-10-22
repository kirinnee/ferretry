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

  it('should pass --use-case and --json through', async () => {
    // Arrange
    const { program, calls } = build();

    // Act
    await program.parseAsync(['node', 'fy', 'recommend', 'x', '--use-case', 'bulk', '--json']);

    // Assert
    should(calls).eql([{ words: ['x'], options: { useCase: 'bulk', json: true } }]);
  });

  it('should refuse a missing task before the controller is asked', async () => {
    // Arrange
    const { program, calls } = build();

    // Act + Assert
    await should(program.parseAsync(['node', 'fy', 'recommend'])).be.rejected();
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
      suggest: record('suggest'),
      accept: record('accept'),
      undo: record('undo'),
      describe: record('describe'),
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
      'suggest',
      '--runtime',
      'claude-work',
      '--model',
      'opus',
      '--prefs',
      'Opus first.',
      '-y',
      '--json',
    );
    await parse(program, 'accept', 'run-1', '--only', 'bulk,plan', '--keep-routing');
    await parse(program, 'undo');
    await parse(program, 'describe', 'glm-5', 'Cheap', 'and', 'fast.', '--provider', 'zai');
    await parse(program, 'describe', 'glm-5', '--clear');

    // Assert
    should(calls.map(call => [call[0], ...call.slice(1).filter(arg => !(arg instanceof Command))])).eql([
      ['show', {}],
      ['show', { json: true }],
      ['inventory', { json: true }],
      ['suggest', { runtime: 'claude-work', model: 'opus', prefs: 'Opus first.', apply: true, json: true }],
      ['accept', 'run-1', { only: 'bulk,plan', keepRouting: true }],
      ['undo'],
      ['describe', 'glm-5', ['Cheap', 'and', 'fast.'], { provider: 'zai' }],
      ['describe', 'glm-5', [], { clear: true }],
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
