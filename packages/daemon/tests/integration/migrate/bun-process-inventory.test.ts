import { describe, it } from 'bun:test';
import should from 'should';
import { BunCommandPort, PaneProcessInventory } from '../../../src/adapters/migrate/bun-process-inventory.ts';
import type { CommandPort, CommandResult } from '../../../src/lib/migrate/process-inventory-port.ts';

class FakeCommands implements CommandPort {
  readonly calls: Array<readonly [string, readonly string[]]> = [];

  constructor(private readonly responses: ReadonlyMap<string, CommandResult>) {}

  async execute(command: string, arguments_: readonly string[]): Promise<CommandResult> {
    this.calls.push([command, arguments_]);
    const result = this.responses.get(command);
    if (!result) throw new Error(`unexpected command: ${command}`);
    return result;
  }
}

describe('PaneProcessInventory', () => {
  it('should inspect only pane descendants through the injected command port', async () => {
    // Arrange
    const commands = new FakeCommands(
      new Map([
        ['tmux', { code: 0, stdout: '100\n', stderr: '' }],
        ['ps', { code: 0, stdout: '100 1 50 harness\n200 100 20 npm test\n300 1 10 unrelated', stderr: '' }],
        ['readlink', { code: 0, stdout: '/work/repository\n', stderr: '' }],
      ]),
    );

    // Act
    const actual = await new PaneProcessInventory(commands).collect('isolated-session');

    // Assert
    should(actual).deepEqual([
      { pid: 200, argv: 'npm test', startedSecondsAgo: 20, cwd: '/work/repository', verdict: 're_armable' },
    ]);
    should(commands.calls).deepEqual([
      ['tmux', ['display-message', '-p', '-t', 'isolated-session', '#{pane_pid}']],
      ['ps', ['-Ao', 'pid=,ppid=,etimes=,args=']],
      ['readlink', ['/proc/200/cwd']],
    ]);
  });

  it('should return no inventory when the pane is absent or command execution fails', async () => {
    // Arrange
    const absent = new FakeCommands(new Map([['tmux', { code: 1, stdout: '', stderr: 'missing' }]]));
    const throwing: CommandPort = { execute: async () => Promise.reject(new Error('unavailable')) };

    // Act + Assert
    should(await new PaneProcessInventory(absent).collect('isolated-session')).deepEqual([]);
    should(await new PaneProcessInventory(throwing).collect('isolated-session')).deepEqual([]);
  });

  it('should execute a real safe command through the Bun adapter', async () => {
    // Arrange
    const executable = Bun.which('printf');
    if (!executable) throw new Error('printf executable is required for this isolated integration test');

    // Act
    const actual = await new BunCommandPort().execute(executable, ['ok']);

    // Assert
    should(actual).deepEqual({ code: 0, stdout: 'ok', stderr: '' });
  });
});
