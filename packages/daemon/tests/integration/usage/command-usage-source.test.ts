import { describe, it } from 'bun:test';
import should from 'should';
import {
  BunCommandRunner,
  CommandUsageSource,
  type CommandOutput,
  type CommandRunnerPort,
} from '../../../src/adapters/usage/index.ts';

const runner = (output: CommandOutput | Error): CommandRunnerPort => ({
  run: async () => {
    if (output instanceof Error) throw output;
    return output;
  },
});

const print = (value: unknown): readonly [string, ...string[]] => [
  process.execPath,
  '-e',
  `console.log(${JSON.stringify(JSON.stringify(value))})`,
];

describe('CommandUsageSource', () => {
  it('should read accounts from the command output', async () => {
    // Arrange
    const source = new CommandUsageSource(runner({ code: 0, stdout: '{"accounts":[{"agent":"writer"}]}' }), ['noop']);

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).deepEqual([{ agent: 'writer' }]);
  });

  it('should report nothing when the command fails', async () => {
    // Arrange
    const source = new CommandUsageSource(runner({ code: 1, stdout: '{"accounts":[]}' }), ['noop']);

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).be.undefined();
  });

  it('should report nothing when the output is not JSON', async () => {
    // Arrange
    const source = new CommandUsageSource(runner({ code: 0, stdout: 'command not found' }), ['noop']);

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).be.undefined();
  });

  it('should report nothing when the command cannot be spawned', async () => {
    // Arrange
    const source = new CommandUsageSource(runner(new Error('ENOENT')), ['missing']);

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).be.undefined();
  });
});

describe('BunCommandRunner', () => {
  it('should capture the standard output of a real command', async () => {
    // Arrange
    const source = new CommandUsageSource(new BunCommandRunner(process.env), print({ accounts: [{ agent: 'real' }] }));

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).deepEqual([{ agent: 'real' }]);
  });

  it('should surface a non-zero exit as an unreadable source', async () => {
    // Arrange
    const command: readonly [string, ...string[]] = [process.execPath, '-e', 'process.exit(3)'];
    const source = new CommandUsageSource(new BunCommandRunner(process.env, { timeoutMs: 30_000 }), command);

    // Act
    const accounts = await source.read();

    // Assert
    should(accounts).be.undefined();
  });

  it('should stop a command that outlives the caller', async () => {
    // Arrange
    const controller = new AbortController();
    const runnerUnderTest = new BunCommandRunner(process.env, { maxOutputBytes: 1024 });
    const command: readonly [string, ...string[]] = [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'];

    // Act
    const pending = runnerUnderTest.run(command, controller.signal);
    controller.abort();
    const result = await pending;

    // Assert
    should(result.code).not.equal(0);
  });
});
