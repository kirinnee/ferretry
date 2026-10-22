import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerGuideCommand, registerRecommendCommand } from '../../../src/lib/pack/commands.ts';
import type { PackController, PackGuideShowOptions, PackRecommendOptions } from '../../../src/lib/pack/controller.ts';

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
    const calls: PackGuideShowOptions[] = [];
    const failures: unknown[] = [];
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const controller = {
      showGuide: async (options: PackGuideShowOptions) => {
        calls.push(options);
        if (failure !== undefined) throw failure;
      },
    } as unknown as PackController;
    registerGuideCommand(program, controller, { fail: error => void failures.push(error) });
    return { program, calls, failures };
  }

  it('should show the guide, with --json passed through', async () => {
    // Arrange
    const { program, calls } = guide();

    // Act
    await program.parseAsync(['node', 'fy', 'guide', 'show']);
    await program.parseAsync(['node', 'fy', 'guide', 'show', '--json']);

    // Assert
    should(calls).eql([{}, { json: true }]);
  });

  it('should hand a failure to the reporter', async () => {
    // Arrange
    const failure = new Error('no daemon');
    const { program, failures } = guide(failure);

    // Act
    await program.parseAsync(['node', 'fy', 'guide', 'show']);

    // Assert
    should(failures).eql([failure]);
  });
});
