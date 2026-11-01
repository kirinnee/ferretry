import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  BunProcessProbe,
  listeningInodes,
  PaneProcessInventory,
  ProjectMcpServers,
  TmuxPaneSnapshot,
} from '../../../src/adapters/migrate/bun-process-inventory.ts';
import type { ConfiguredServer } from '../../../src/lib/migrate/harness-provenance.ts';
import type { ProcessProbePort, ProcessTableRead } from '../../../src/lib/migrate/process-inventory-port.ts';
import { descendantsOf, type ProcRow, parseProcessTable } from '../../../src/lib/migrate/process-table.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/tmux/contracts.ts';
import { PANE_PROOF_FORMAT } from '../../../src/lib/tmux/pane-proof.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * A tmux that answers per COMMAND, because absence is now two questions rather than one.
 *
 * `has-session` is what the adapters ask after a failed read to tell "this session is gone" from
 * "tmux would not answer", so a fake that returned one result for every command could not express
 * the difference the adapters exist to draw. It defaults to a server that CONFIRMS the session is
 * there, which is the conservative half: a case must opt into absence.
 */
class FakeTmux implements TmuxCommandPort {
  readonly calls: Array<readonly string[]> = [];

  constructor(
    private readonly result: TmuxCommandResult,
    private readonly hasSession: TmuxCommandResult = { code: 0, stdout: '', stderr: '' },
  ) {}

  async execute(arguments_: readonly string[]): Promise<TmuxCommandResult> {
    this.calls.push(arguments_);
    return arguments_[0] === 'has-session' ? this.hasSession : this.result;
  }
}

/** The pane proof tmux prints for a live pane running `pid`. */
const livePane = (pid: number): string => `%3|${String(pid)}|0|1792626406\n`;

/** What tmux answers about a session it does not have. */
const NO_SUCH_SESSION: TmuxCommandResult = { code: 1, stdout: '', stderr: "can't find session: isolated-session\n" };

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

const provenance = { binaryName: 'fy', servers: { read: async (): Promise<readonly ConfiguredServer[]> => [] } };

describe('PaneProcessInventory', () => {
  it('should inspect only pane descendants through the socket-scoped tmux port', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 0, stdout: livePane(100), stderr: '' });
    const probe = new FakeProbe(table('100 1 50 harness\n200 100 20 npm test\n300 1 10 unrelated'));

    // Act
    const actual = await new PaneProcessInventory(tmux, probe, provenance).collect('isolated-session');

    // Assert
    should(actual).deepEqual({
      kind: 'observed',
      processes: [
        {
          pid: 200,
          argv: 'npm test',
          startedSecondsAgo: 20,
          cwd: '/work/repository',
          verdict: 're_armable',
          ppid: 100,
        },
      ],
    });
    should(tmux.calls).deepEqual([['display-message', '-p', '-t', 'isolated-session', PANE_PROOF_FORMAT]]);
    should(probe.workingDirectoryCalls).deepEqual([200, 100]);
  });

  it('should report an unresolvable pane as unobservable while the session still exists', async () => {
    // tmux answers the second question — the session IS there — so the failed pane-pid read is a
    // genuine blind spot: something is running under a pane nobody could inspect.
    // Arrange
    const tmux = new FakeTmux({ code: 1, stdout: '', stderr: "no server running on '/tmp/fy.sock'\n" });

    // Act
    const actual = await new PaneProcessInventory(tmux, new FakeProbe(table('')), provenance).collect(
      'isolated-session',
    );

    // Assert
    should(actual).deepEqual({
      kind: 'unobservable',
      reason: "the pane pid could not be resolved: no server running on '/tmp/fy.sock'",
    });
  });

  it('should report a pane tmux confirms is gone as an empty observation, not a blind spot', async () => {
    // THE COMMONEST MIGRATION THERE IS. A session whose account died has no pane at all, and a
    // failed pane-pid read used to be unobservable unconditionally — which made the report carry an
    // `unknown` verdict and the gate refuse the very move the operator was trying to make. tmux is
    // asked outright, and a session it says does not exist ran nothing.
    // Arrange
    const tmux = new FakeTmux({ code: 1, stdout: '', stderr: 'no server running\n' }, NO_SUCH_SESSION);

    // Act
    const actual = await new PaneProcessInventory(tmux, new FakeProbe(table('')), provenance).collect(
      'isolated-session',
    );

    // Assert
    should(actual).deepEqual({ kind: 'observed', processes: [] });
    should(tmux.calls).deepEqual([
      ['display-message', '-p', '-t', 'isolated-session', PANE_PROOF_FORMAT],
      ['has-session', '-t', 'isolated-session'],
    ]);
  });

  it('should report a silent tmux failure with its exit code', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 3, stdout: '', stderr: '   ' });

    // Act
    const actual = await new PaneProcessInventory(tmux, new FakeProbe(table('')), provenance).collect(
      'isolated-session',
    );

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
    const actual = await new PaneProcessInventory(tmux, new FakeProbe(table('')), provenance).collect(
      'isolated-session',
    );

    // Assert
    should(actual).deepEqual({
      kind: 'unobservable',
      reason: 'tmux reported an unusable pane pid "not-a-pid"',
    });
  });

  it('should report a dead pane as running nothing, with or without the pid tmux 3.8 no longer prints', async () => {
    // Arrange — tmux 3.8 blanks a dead pane's pid; 3.6a and 3.7 keep it, but its process is gone either way.
    const on38 = new FakeTmux({ code: 0, stdout: '%3||1|1792626406\n', stderr: '' });
    const probe = new FakeProbe(table(''));

    // Act
    const actual = await new PaneProcessInventory(on38, probe, provenance).collect('isolated-session');

    // Assert — observed, not a blind spot, and no process was looked for.
    should(actual).deepEqual({ kind: 'observed', processes: [] });
    should(probe.workingDirectoryCalls).deepEqual([]);
  });

  it('should surface a failed process-table read as the blind spot it is', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 0, stdout: livePane(100), stderr: '' });
    const probe = new FakeProbe({ kind: 'failed', reason: 'ps exited 1: cannot allocate memory' });

    // Act
    const actual = await new PaneProcessInventory(tmux, probe, provenance).collect('isolated-session');

    // Assert
    should(actual).deepEqual({
      kind: 'unobservable',
      reason: 'the process table could not be read: ps exited 1: cannot allocate memory',
    });
  });

  it('should report a rejected session name instead of silently seeing nothing', async () => {
    // Arrange — an invalid tmux target throws inside the address validator.
    const tmux = new FakeTmux({ code: 0, stdout: livePane(100), stderr: '' });

    // Act
    const actual = await new PaneProcessInventory(tmux, new FakeProbe(table('')), provenance).collect('NOT A SESSION');

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

/** `/proc/<pid>/stat` with the fields a subtree read uses: comm, parent, start time in ticks. */
const stat = (pid: number, comm: string, ppid: number | string, ticks: number): string =>
  `${String(pid)} (${comm}) S ${String(ppid)} ${'0 '.repeat(17)}${String(ticks)} 0 0\n`;

/** A procfs written by hand: every shape a live one can take between two reads. */
async function fakeProc(root: string): Promise<void> {
  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  };
  await write('uptime', '1000.50 999.00\n');
  // Two threads of the root, listing one child twice and pid 1 once.
  await write('100/task/100/children', '201 200 1 ');
  await write('100/task/101/children', '300 200');
  await write('200/stat', stat(200, 'node', 100, 50_000));
  await write('200/cmdline', 'node\0x.js\0');
  await write('200/task/200/children', '400 ');
  // 400 exited between being listed and being read: no stat at all.
  await write('201/stat', stat(201, 'kw)x', 100, 99_000));
  await write('201/cmdline', '');
  // 201 has no task directory: it went before its children could be listed.
  await write('300/stat', stat(300, 'sh', 100, 100_000));
  await write('300/cmdline', 'echo\0a\nb\0');
  await write('300/task/300/children', '500');
  await write('500/stat', stat(500, 'odd', 'not-a-pid', 1));
  await write('500/cmdline', 'odd');
}

describe('BunProcessProbe, reading one subtree from procfs', () => {
  it('should walk only the subtree, in table order, as `ps` would print each row', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'fy-proc-'));
    await fakeProc(root);
    const subject = new BunProcessProbe(undefined, { procRoot: root });

    try {
      // Act
      const actual = await subject.descendants(100);

      // Assert
      should(actual).deepEqual([
        { pid: 200, ppid: 100, startedSecondsAgo: 500, argv: 'node x.js' },
        { pid: 201, ppid: 100, startedSecondsAgo: 10, argv: '[kw)x]' },
        { pid: 300, ppid: 100, startedSecondsAgo: 0, argv: 'echo a?b' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should hand the question back to the full table whenever procfs cannot answer it', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'fy-proc-'));
    await fakeProc(root);
    const noUptime = await mkdtemp(join(tmpdir(), 'fy-proc-'));
    const badUptime = await mkdtemp(join(tmpdir(), 'fy-proc-'));
    await writeFile(join(badUptime, 'uptime'), 'soon\n');

    try {
      // Act + Assert — no procfs, an unreadable root, no uptime, an uptime that is not a number.
      should(await new BunProcessProbe(undefined, { procRoot: undefined }).descendants(100)).be.undefined();
      should(await new BunProcessProbe(undefined, { procRoot: root }).descendants(999)).be.undefined();
      should(await new BunProcessProbe(undefined, { procRoot: noUptime }).descendants(100)).be.undefined();
      should(await new BunProcessProbe(undefined, { procRoot: badUptime }).descendants(100)).be.undefined();
    } finally {
      for (const directory of [root, noUptime, badUptime]) await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(globalThis.process.platform !== 'linux')(
    'should agree with the real ps about a real process tree',
    async () => {
      // Arrange — a shell with two children, and one grandchild under a second shell.
      const ps = Bun.which('ps');
      if (ps === null) throw new Error('ps executable is required for this integration test');
      const tree = Bun.spawn(['/bin/sh', '-c', 'sleep 30 & sleep 31 & /bin/sh -c "sleep 32; :" & wait'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const subject = new BunProcessProbe(ps);

      try {
        await waitFor(
          async () => (await subject.descendants(tree.pid))?.length === 4,
          'the shell to have started its process tree',
        );

        // Act
        const actual = await subject.descendants(tree.pid);
        const table = await subject.processTable();

        // Assert
        if (table.kind !== 'read') throw new Error(table.reason);
        const expected = descendantsOf(tree.pid, parseProcessTable(table.stdout));
        const shape = (rows: readonly ProcRow[] | undefined) =>
          rows?.map(({ pid, ppid, argv }) => ({ pid, ppid, argv }));
        should(shape(actual)).deepEqual(shape(expected));
        should(actual?.length).equal(4);
        for (const [index, row] of (actual ?? []).entries())
          should(Math.abs(row.startedSecondsAgo - (expected[index]?.startedSecondsAgo ?? -9))).be.belowOrEqual(1);
      } finally {
        tree.kill();
      }
    },
  );

  it('should let one table answer every ask inside its time-to-live, and never hold a failed read', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'fy-ps-ttl-'));
    const count = join(root, 'count');
    const executable = join(root, 'ps.sh');
    const failing = join(root, 'failing.sh');
    await writeFile(executable, `#!/bin/sh\nprintf x >> '${count}'\nprintf '  2 1 00:01 init\\n'\n`);
    await writeFile(failing, `#!/bin/sh\nprintf y >> '${count}'\nexit 1\n`);
    await chmod(executable, 0o700);
    await chmod(failing, 0o700);
    let now = 0;
    const cached = new BunProcessProbe(executable, { tableTtlMs: 1_000, nowMs: () => now, procRoot: undefined });
    const uncached = new BunProcessProbe(failing, { tableTtlMs: 1_000, nowMs: () => now });

    try {
      // Act
      const first = await cached.processTable();
      now = 999;
      const held = await cached.processTable();
      now = 1_000;
      await cached.processTable();
      await uncached.processTable();
      await uncached.processTable();

      // Assert
      should(held).equal(first);
      should(await readFile(count, 'utf8')).equal('xxyy');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PaneProcessInventory, over a probe that reads one subtree', () => {
  it('should not read the full table when the probe can read the subtree', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 0, stdout: livePane(100), stderr: '' });
    let tables = 0;
    const probe: ProcessProbePort = {
      processTable: async () => {
        tables += 1;
        return table('');
      },
      descendants: async () => [{ pid: 200, ppid: 100, startedSecondsAgo: 5, argv: 'sleep 30' }],
      workingDirectory: async () => '/work',
    };

    // Act
    const actual = await new PaneProcessInventory(tmux, probe, provenance).collect('fy-session');

    // Assert
    should(actual).match({ kind: 'observed', processes: [{ pid: 200, argv: 'sleep 30', cwd: '/work' }] });
    should(tables).equal(0);
  });

  it('should read the full table when the probe cannot read the subtree', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 0, stdout: livePane(100), stderr: '' });
    const probe: ProcessProbePort = {
      processTable: async () => table('  200   100 00:05 sleep 30\n  300     1 00:05 other\n'),
      descendants: async () => undefined,
      workingDirectory: async () => '/work',
    };

    // Act
    const actual = await new PaneProcessInventory(tmux, probe, provenance).collect('fy-session');

    // Assert
    should(actual).match({ kind: 'observed', processes: [{ pid: 200, argv: 'sleep 30' }] });
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
    // Both fakes confirm the session exists, so a failed capture is a pane that could not be read —
    // which the preflight must record as a blind spot rather than as an empty codex footer.
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

  it('should answer nothing at all for a pane tmux confirms is gone', async () => {
    // `undefined` is the codex footer of a session that no longer has a terminal: there is nothing
    // to count, which is different from a footer that could not be read. Raising here would make
    // every stopped codex session refuse its own migration on evidence nobody could have produced.
    // Arrange
    const tmux = new FakeTmux({ code: 1, stdout: '', stderr: "can't find pane\n" }, NO_SUCH_SESSION);

    // Act
    const actual = await new TmuxPaneSnapshot(tmux).visible('isolated-session');

    // Assert
    should(actual).be.undefined();
    should(tmux.calls).deepEqual([
      ['capture-pane', '-p', '-t', 'isolated-session'],
      ['has-session', '-t', 'isolated-session'],
    ]);
  });
});

const fixtureTable = (name: string): ProcessTableRead => ({
  kind: 'read',
  stdout: readFileSync(`${import.meta.dir}/../../fixtures/ps/${name}`, 'utf8'),
});

describe('PaneProcessInventory, over real process tables', () => {
  it('should not call the harness’s own Ferretry tools server unknown (the owner’s refusal)', async () => {
    // Arrange — `claude` IS the pane process here, as tmux reports it, and `fy mcp serve` is its child.
    const tmux = new FakeTmux({ code: 0, stdout: livePane(3887833), stderr: '' });
    const probe = new FakeProbe(fixtureTable('linux-owner-case.txt'));

    // Act
    const actual = await new PaneProcessInventory(tmux, probe, provenance).collect('fy-session');

    // Assert
    should(actual).deepEqual({
      kind: 'observed',
      processes: [
        {
          pid: 3_887_914,
          argv: 'fy mcp serve',
          startedSecondsAgo: 2 * 86_400 + 2 * 3600 + 46 * 60 + 29,
          cwd: '/work/repository',
          verdict: 'safe_to_kill',
          known: { kind: 'ferretry-tools', label: 'The Ferretry tools server' },
          ppid: 3_887_833,
        },
      ],
    });
  });

  it('should read the project’s configured servers from the pane directory and explain macOS npx servers', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 0, stdout: livePane(412), stderr: '' });
    const asked: string[] = [];
    const servers = {
      read: async (directory: string): Promise<readonly ConfiguredServer[]> => {
        asked.push(directory);
        return [{ name: 'search', command: 'npx', args: ['-y', '@acme/search-mcp@latest'] }];
      },
    };

    // Act
    const actual = await new PaneProcessInventory(tmux, new FakeProbe(fixtureTable('macos-claude-pane.txt')), {
      binaryName: 'fy',
      servers,
    }).collect('fy-session');

    // Assert
    if (actual.kind !== 'observed') throw new Error('expected an observation');
    should(asked).deepEqual(['/work/repository']);
    should(actual.processes.map(entry => [entry.pid, entry.verdict, entry.known?.kind])).deepEqual([
      [413, 'safe_to_kill', 'harness'],
      [431, 'safe_to_kill', 'ferretry-tools'],
      [455, 'safe_to_kill', 'configured-server'],
      [611, 'unknown', undefined],
      [620, 'unknown', undefined],
      [460, 'safe_to_kill', 'configured-server'],
      [612, 'safe_to_kill', undefined],
      [621, 'unknown', undefined],
    ]);
  });

  it('should leave configured servers unexplained when the pane directory is not readable', async () => {
    // Arrange — macOS has no /proc, so the working directory is unknown and nothing is read or guessed.
    const tmux = new FakeTmux({ code: 0, stdout: livePane(412), stderr: '' });
    const servers = {
      read: async (): Promise<readonly ConfiguredServer[]> => {
        throw new Error('must not be asked');
      },
    };

    // Act
    const actual = await new PaneProcessInventory(
      tmux,
      { processTable: async () => fixtureTable('macos-claude-pane.txt'), workingDirectory: async () => undefined },
      { binaryName: 'fy', servers },
    ).collect('fy-session');

    // Assert
    if (actual.kind !== 'observed') throw new Error('expected an observation');
    should(actual.processes.find(entry => entry.pid === 455)?.verdict).equal('unknown');
    should(actual.processes.find(entry => entry.pid === 431)?.known?.kind).equal('ferretry-tools');
  });
});

describe('ProjectMcpServers', () => {
  it('should read the servers of the .mcp.json in a directory, and none from anywhere else', async () => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'fy-mcp-servers-'));
    try {
      await writeFile(
        join(directory, '.mcp.json'),
        JSON.stringify({ mcpServers: { search: { command: 'npx', args: ['search-mcp'] } } }),
      );
      const empty = await mkdtemp(join(tmpdir(), 'fy-mcp-none-'));

      // Act
      const found = await new ProjectMcpServers().read(directory);
      const none = await new ProjectMcpServers().read(empty);
      const missing = await new ProjectMcpServers().read(join(empty, 'absent'));

      // Assert
      should(found).deepEqual([{ name: 'search', command: 'npx', args: ['search-mcp'] }]);
      should(none).deepEqual([]);
      should(missing).deepEqual([]);
      await rm(empty, { recursive: true, force: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('BunProcessProbe — which processes are servers', () => {
  const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const tcpRow = (state: string, inode: string): string =>
    `   0: 0100007F:1F90 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

  it('should name only the processes holding a LISTEN socket, from procfs', async () => {
    // Arrange — 201 listens on inode 5001; 202 holds an ESTABLISHED socket; 203 holds only a file.
    const root = await mkdtemp(join(tmpdir(), 'fy-proc-listen-'));
    try {
      await mkdir(join(root, 'net'), { recursive: true });
      await writeFile(join(root, 'net', 'tcp'), [TCP_HEADER, tcpRow('0A', '5001'), tcpRow('01', '5002')].join('\n'));
      await writeFile(join(root, 'net', 'tcp6'), TCP_HEADER);

      for (const [pid, target] of [
        [201, 'socket:[5001]'],
        [202, 'socket:[5002]'],
        [203, '/dev/null'],
      ] as const) {
        await mkdir(join(root, String(pid), 'fd'), { recursive: true });
        await symlink(target, join(root, String(pid), 'fd', '3'));
      }
      const subject = new BunProcessProbe(undefined, { procRoot: root });

      // Act
      const listening = await subject.listening([201, 202, 203, 204]);

      // Assert
      should([...(listening ?? [])]).deepEqual([201]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should say it cannot tell where there is no procfs', async () => {
    // Act / Assert
    should(await new BunProcessProbe(undefined, { procRoot: undefined }).listening([1])).be.undefined();
  });

  it('should read the LISTEN inodes of a /proc/net/tcp table', () => {
    // Act / Assert
    should(listeningInodes([TCP_HEADER, tcpRow('0A', '7'), tcpRow('01', '8'), tcpRow('0A', '0')].join('\n'))).deepEqual(
      ['7'],
    );
  });
});

describe('BunProcessProbe, looking up pids wherever they are', () => {
  it('should read each pid from procfs, whoever its parent is, and leave out the ones not running', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'fy-proc-'));
    await fakeProc(root);
    const subject = new BunProcessProbe(undefined, { procRoot: root });

    try {
      // Act
      const actual = await subject.lookup([200, 400, 999]);

      // Assert
      should([...actual.entries()]).deepEqual([
        [200, { pid: 200, ppid: 100, startedSecondsAgo: 500, argv: 'node x.js' }],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should throw rather than answer "gone" when procfs gives no usable uptime', async () => {
    // Arrange
    const badUptime = await mkdtemp(join(tmpdir(), 'fy-proc-'));
    await writeFile(join(badUptime, 'uptime'), 'soon\n');

    try {
      // Act
      const read = new BunProcessProbe(undefined, { procRoot: badUptime }).lookup([1]);

      // Assert
      await should(read).be.rejectedWith(/uptime/);
    } finally {
      await rm(badUptime, { recursive: true, force: true });
    }
  });

  it('should read the real table where there is no procfs, and throw when it cannot read one', async () => {
    // Arrange
    const executable = Bun.which('ps');
    if (!executable) throw new Error('ps executable is required for this isolated integration test');

    // Act
    const own = await new BunProcessProbe(executable, { procRoot: undefined }).lookup([
      globalThis.process.pid,
      4_194_305,
    ]);
    const unreadable = new BunProcessProbe(undefined, { procRoot: undefined }).lookup([1]);

    // Assert
    should([...own.keys()]).deepEqual([globalThis.process.pid]);
    await should(unreadable).be.rejectedWith(/ps executable/);
  });
});
