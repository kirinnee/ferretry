import { describe, it } from 'bun:test';
import should from 'should';
import {
  BunProcessProbe,
  PaneProcessInventory,
  TmuxPaneSnapshot,
} from '../../../src/adapters/migrate/bun-process-inventory.ts';
import type { ProcessProbePort, ProcessTableRead } from '../../../src/lib/migrate/process-inventory-port.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/tmux/contracts.ts';

class FakeTmux implements TmuxCommandPort {
  readonly calls: Array<readonly string[]> = [];

  constructor(private readonly result: TmuxCommandResult) {}

  async execute(arguments_: readonly string[]): Promise<TmuxCommandResult> {
    this.calls.push(arguments_);
    return this.result;
  }
}

class FakeProbe implements ProcessProbePort {
  readonly workingDirectoryCalls: number[] = [];

  constructor(
    private readonly table: ProcessTableRead,
    private readonly cwd: string | undefined = '/work/repository',
  ) {}

  async processTable(): Promise<ProcessTableRead> {
    return this.table;
  }

  async workingDirectory(pid: number): Promise<string | undefined> {
    this.workingDirectoryCalls.push(pid);
    return this.cwd;
  }
}

const table = (stdout: string): ProcessTableRead => ({ kind: 'read', stdout });

describe('PaneProcessInventory', () => {
  it('should inspect only pane descendants through the socket-scoped tmux port', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 0, stdout: '100\n', stderr: '' });
    const probe = new FakeProbe(table('100 1 50 harness\n200 100 20 npm test\n300 1 10 unrelated'));

    // Act
    const actual = await new PaneProcessInventory(tmux, probe).collect('isolated-session');

    // Assert
    should(actual).deepEqual({
      kind: 'observed',
      processes: [
        { pid: 200, argv: 'npm test', startedSecondsAgo: 20, cwd: '/work/repository', verdict: 're_armable' },
      ],
    });
    should(tmux.calls).deepEqual([['display-message', '-p', '-t', 'isolated-session', '#{pane_pid}']]);
    should(probe.workingDirectoryCalls).deepEqual([200]);
  });

  it('should report an unresolvable pane as unobservable rather than empty', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 1, stdout: '', stderr: "no server running on '/tmp/fy.sock'\n" });

    // Act
    const actual = await new PaneProcessInventory(tmux, new FakeProbe(table(''))).collect('isolated-session');

    // Assert
    should(actual).deepEqual({
      kind: 'unobservable',
      reason: "the pane pid could not be resolved: no server running on '/tmp/fy.sock'",
    });
  });

  it('should report a silent tmux failure with its exit code', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 3, stdout: '', stderr: '   ' });

    // Act
    const actual = await new PaneProcessInventory(tmux, new FakeProbe(table(''))).collect('isolated-session');

    // Assert
    should(actual).deepEqual({
      kind: 'unobservable',
      reason: 'the pane pid could not be resolved: tmux exited 3',
    });
  });

  it('should reject a pane pid that cannot own a process tree', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 0, stdout: 'not-a-pid\n', stderr: '' });

    // Act
    const actual = await new PaneProcessInventory(tmux, new FakeProbe(table(''))).collect('isolated-session');

    // Assert
    should(actual).deepEqual({
      kind: 'unobservable',
      reason: 'tmux reported an unusable pane pid "not-a-pid"',
    });
  });

  it('should surface a failed process-table read as the blind spot it is', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 0, stdout: '100\n', stderr: '' });
    const probe = new FakeProbe({ kind: 'failed', reason: 'ps exited 1: cannot allocate memory' });

    // Act
    const actual = await new PaneProcessInventory(tmux, probe).collect('isolated-session');

    // Assert
    should(actual).deepEqual({ kind: 'unobservable', reason: 'ps exited 1: cannot allocate memory' });
  });

  it('should report a rejected session name instead of silently seeing nothing', async () => {
    // Arrange — an invalid tmux target throws inside the address validator.
    const tmux = new FakeTmux({ code: 0, stdout: '100\n', stderr: '' });

    // Act
    const actual = await new PaneProcessInventory(tmux, new FakeProbe(table(''))).collect('NOT A SESSION');

    // Assert
    should(actual).deepEqual({
      kind: 'unobservable',
      reason: 'the pane could not be inspected: session must be a lowercase tmux name',
    });
  });
});

describe('BunProcessProbe', () => {
  it('should read the real process table through an absolute ps executable', async () => {
    // Arrange
    const executable = Bun.which('ps');
    if (!executable) throw new Error('ps executable is required for this isolated integration test');

    // Act
    const actual = await new BunProcessProbe(executable).processTable();

    // Assert — the reader's own pid must appear in the table it just read.
    if (actual.kind !== 'read') throw new Error(`expected a read, got: ${actual.reason}`);
    should(actual.stdout).match(new RegExp(`^\\s*${globalThis.process.pid}\\s`, 'm'));
  });

  it('should refuse to resolve ps from the executable search path', async () => {
    // Act
    const unresolved = await new BunProcessProbe(undefined).processTable();
    const relative = await new BunProcessProbe('ps').processTable();

    // Assert
    const reason = 'no absolute ps executable is available to read the process table';
    should(unresolved).deepEqual({ kind: 'failed', reason });
    should(relative).deepEqual({ kind: 'failed', reason });
  });

  it('should report a non-zero ps exit as a failed read', async () => {
    // Arrange — `false` accepts and ignores the ps arguments, then exits non-zero.
    const executable = Bun.which('false');
    if (!executable) throw new Error('false executable is required for this isolated integration test');

    // Act
    const actual = await new BunProcessProbe(executable).processTable();

    // Assert
    should(actual).deepEqual({ kind: 'failed', reason: 'ps exited 1: no output' });
  });

  it('should report an unspawnable ps as a failed read', async () => {
    // Act
    const actual = await new BunProcessProbe('/nonexistent/ferretry-test-ps').processTable();

    // Assert
    if (actual.kind !== 'failed') throw new Error('expected an unspawnable ps to fail the read');
    should(actual.reason).startWith('ps could not be run: ');
  });

  it('should read its own working directory and tolerate a pid it cannot see', async () => {
    // Act
    const own = await new BunProcessProbe(undefined).workingDirectory(globalThis.process.pid);
    const absent = await new BunProcessProbe(undefined).workingDirectory(0);

    // Assert
    should(own).equal(globalThis.process.cwd());
    should(absent).be.undefined();
  });
});

describe('TmuxPaneSnapshot', () => {
  it('should capture the visible pane through the socket-scoped tmux port', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 0, stdout: '2 background terminals running\n', stderr: '' });

    // Act
    const actual = await new TmuxPaneSnapshot(tmux).visible('isolated-session');

    // Assert
    should(actual).equal('2 background terminals running\n');
    should(tmux.calls).deepEqual([['capture-pane', '-p', '-t', 'isolated-session']]);
  });

  it('should raise a capture failure rather than return an empty pane', async () => {
    // Arrange
    const reported = new FakeTmux({ code: 1, stdout: '', stderr: "can't find pane\n" });
    const silent = new FakeTmux({ code: 2, stdout: '', stderr: '' });

    // Act + Assert
    await should(new TmuxPaneSnapshot(reported).visible('isolated-session')).be.rejectedWith(
      "tmux could not capture the pane: can't find pane",
    );
    await should(new TmuxPaneSnapshot(silent).visible('isolated-session')).be.rejectedWith(
      'tmux could not capture the pane: exited 2',
    );
  });
});
