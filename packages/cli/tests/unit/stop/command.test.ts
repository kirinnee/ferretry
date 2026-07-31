import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerStopCommands } from '../../../src/lib/stop/command';
import type { BulkStopOptions, BulkStopResult, BulkStopSelector, IBulkStopRunner } from '../../../src/lib/stop/types';

interface Call {
  readonly selector: BulkStopSelector;
  readonly options: BulkStopOptions;
}

function harness() {
  const calls: Call[] = [];
  const runner: IBulkStopRunner = {
    run: async (selector, options): Promise<BulkStopResult> => {
      calls.push({ selector, options });
      return { exitCode: 0, confirmed: false };
    },
  };
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerStopCommands(program, runner);
  const run = (...argv: string[]) => program.parseAsync(['node', 'fy', ...argv]);
  return { calls, run };
}

describe('the stop command surface', () => {
  it('should map each mode onto its selector', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('stop', 'orphan', 'abc', '--yes');
    await run('stop', 'cascade', 'abc', '--yes');
    await run('stop', 'children', 'abc', '--yes');
    await run('stop', 'label', 'batch', '--yes');

    // Assert
    should(calls.map(call => call.selector)).deepEqual([
      { kind: 'orphan', rootId: 'abc' },
      { kind: 'cascade', rootId: 'abc' },
      { kind: 'children', rootId: 'abc' },
      { kind: 'label', label: 'batch' },
    ]);
  });

  it('should pass the safety flags through', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('stop', 'cascade', 'abc', '--dry-run', '--include-caller');

    // Assert
    should(calls[0]?.options.dryRun).be.true();
    should(calls[0]?.options.includeCaller).be.true();
    should(calls[0]?.options.yes).be.undefined();
  });

  it('should take a reason written on the mode itself', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('stop', 'label', 'batch', '--yes', '--reason', 'shift over');

    // Assert
    should(calls[0]?.options.reason).equal('shift over');
  });

  it('should inherit a reason written before the mode', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('stop', '--reason', 'parent said so', 'label', 'batch', '--yes');

    // Assert
    should(calls[0]?.options.reason).equal('parent said so');
  });

  it('should let a reason on the mode beat one on the parent', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act
    await run('stop', '--reason', 'parent', 'label', 'batch', '--yes', '--reason', 'mode');

    // Assert
    should(calls[0]?.options.reason).equal('mode');
  });

  it('should refuse a mode with no argument instead of sweeping everything', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act + Assert
    await should(run('stop', 'label')).be.rejected();
    should(calls).be.empty();
  });

  it('should refuse an unknown mode', async () => {
    // Arrange
    const { calls, run } = harness();

    // Act + Assert
    await should(run('stop', 'everything')).be.rejected();
    should(calls).be.empty();
  });
});
