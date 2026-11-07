import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import should from 'should';
import type { Clock, SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import {
  KernelProcessProbe,
  listeningInodes,
  PaneProcessInventory,
  type ProcessHostFacts,
  ProjectMcpServers,
  TmuxPaneSnapshot,
} from '../../../../daemon/adapters/moves/process-inventory.ts';
import type { ConfiguredServer } from '../../../../daemon/lib/moves/harness-provenance.ts';
import type { ProcessProbePort, ProcessTableRead } from '../../../../daemon/lib/moves/process-inventory-port.ts';
import {
  PANE_PROOF_FORMAT,
  type TmuxCommandPort,
  type TmuxCommandResult,
} from '../../../../daemon/lib/session/peers/tmux-lifecycle.ts';

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

const provenance = {
  binaryName: 'fy',
  toolsServerArguments: ['mcp', 'serve'],
  statuslineSubcommand: 'statusline',
  servers: { read: async (): Promise<readonly ConfiguredServer[]> => [] },
};

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
    // THE COMMONEST MOVE THERE IS. A session whose account died has no pane at all, and a
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

/** A clock the test drives: only the reads the probe makes. */
class DrivenClock implements Pick<Clock, 'nowMs'> {
  constructor(public ms: number) {}
  nowMs(): number {
    return this.ms;
  }
}

/** A `SpawnPort` that answers `ps` from a script and counts how often it was asked. */
class FakePs implements Pick<SpawnPort, 'run'> {
  readonly calls: Array<{ readonly program: string; readonly args: readonly string[] }> = [];

  constructor(private readonly answer: () => Promise<SpawnResult> | SpawnResult) {}

  async run(program: string, args: readonly string[]): Promise<SpawnResult> {
    this.calls.push({ program, args });
    return await this.answer();
  }
}

const printed = (stdout: string): SpawnResult => ({ exitCode: 0, signal: null, stdout, stderr: '' });

/** `/proc/<pid>/stat` with the fields a subtree read uses: comm, parent, start time in ticks. */
const stat = (pid: number, comm: string, ppid: number | string, ticks: number): string =>
  `${String(pid)} (${comm}) S ${String(ppid)} ${'0 '.repeat(17)}${String(ticks)} 0 0\n`;

/** The boot time that makes the clock below read the same uptime (1000.5 s) the old procfs fixture wrote. */
const BOOT_SECONDS = 1_000_000;
const NOW_MS = (BOOT_SECONDS + 1000.5) * 1000;

/** A procfs written by hand, behind the kernel's host facts: every shape a live one can take between two reads. */
class FakeProc implements ProcessHostFacts {
  readonly platform: string;
  readonly files = new Map<string, string>();
  readonly directories = new Map<number, string>();
  readonly links = new Map<string, string>();

  constructor(platform = 'linux') {
    this.platform = platform;
  }

  set(path: string, text: string): this {
    this.files.set(path, text);
    return this;
  }

  private read(path: string): string {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  }

  async procFile(pid: number | 'self', file: string): Promise<string> {
    return this.read(`${String(pid)}/${file}`);
  }

  async procSystemFile(file: string): Promise<string> {
    return this.read(file);
  }

  async procTasks(pid: number): Promise<readonly string[]> {
    const tasks = [...this.files.keys()]
      .map(key => new RegExp(`^${String(pid)}/task/(\\d+)/children$`, 'u').exec(key)?.[1])
      .filter((task): task is string => task !== undefined);
    if (tasks.length === 0) throw new Error(`ENOENT ${String(pid)}/task`);
    return tasks;
  }

  async procTaskChildren(pid: number, task: number): Promise<string> {
    return this.read(`${String(pid)}/task/${String(task)}/children`);
  }

  async procFds(pid: number): Promise<readonly string[]> {
    const fds = [...this.links.keys()]
      .filter(key => key.startsWith(`${String(pid)}/`))
      .map(key => key.split('/')[1] ?? '');
    if (fds.length === 0) throw new Error(`ENOENT ${String(pid)}/fd`);
    return fds;
  }

  async procFdLink(pid: number, fd: string): Promise<string> {
    const link = this.links.get(`${String(pid)}/${fd}`);
    if (link === undefined) throw new Error('ENOENT');
    return link;
  }

  async procWorkingDirectory(pid: number): Promise<string> {
    const directory = this.directories.get(pid);
    if (directory === undefined) throw new Error('ENOENT');
    return directory;
  }
}

/** The shapes of procfs the subtree walk meets, as the old fixture wrote them to disk. */
function fakeProc(): FakeProc {
  return (
    new FakeProc()
      .set('stat', `cpu 1 2 3\nbtime ${String(BOOT_SECONDS)}\n`)
      // Two threads of the root, listing one child twice and pid 1 once.
      .set('100/task/100/children', '201 200 1 ')
      .set('100/task/101/children', '300 200')
      .set('200/stat', stat(200, 'node', 100, 50_000))
      .set('200/cmdline', 'node\0x.js\0')
      .set('200/task/200/children', '400 ')
      // 400 exited between being listed and being read: no stat at all.
      .set('201/stat', stat(201, 'kw)x', 100, 99_000))
      .set('201/cmdline', '')
      // 201 has no task directory: it went before its children could be listed.
      .set('300/stat', stat(300, 'sh', 100, 100_000))
      .set('300/cmdline', 'echo\0a\nb\0')
      .set('300/task/300/children', '500')
      .set('500/stat', stat(500, 'odd', 'not-a-pid', 1))
      .set('500/cmdline', 'odd')
  );
}

const probeOver = (host: ProcessHostFacts, ps: Pick<SpawnPort, 'run'> = new FakePs(() => printed('')), options = {}) =>
  new KernelProcessProbe(ps, host, new DrivenClock(NOW_MS), options);

describe('KernelProcessProbe', () => {
  it('should read the process table through ps, which the kernel resolves by name', async () => {
    // Arrange
    const ps = new FakePs(() => printed('  2 1 00:01 init\n'));

    // Act
    const actual = await probeOver(new FakeProc(), ps).processTable();

    // Assert
    should(actual).deepEqual({ kind: 'read', stdout: '  2 1 00:01 init\n' });
    should(ps.calls).deepEqual([{ program: 'ps', args: ['-Ao', 'pid=,ppid=,etime=,args='] }]);
  });

  it('should report a non-zero ps exit as a failed read', async () => {
    // Arrange
    const ps = new FakePs(() => ({ exitCode: 1, signal: null, stdout: '', stderr: '' }));

    // Act
    const actual = await probeOver(new FakeProc(), ps).processTable();

    // Assert
    should(actual).deepEqual({ kind: 'failed', reason: 'ps exited 1: no output' });
  });

  it('should report a ps the kernel will not run as a failed read', async () => {
    // Arrange — a program the manifest did not declare is refused by the spawn port before anything runs.
    const ps = new FakePs(() => {
      throw new Error('ps is not a declared program');
    });

    // Act
    const actual = await probeOver(new FakeProc(), ps).processTable();

    // Assert
    should(actual).deepEqual({ kind: 'failed', reason: 'ps could not be run: ps is not a declared program' });
  });

  it('should read a process working directory and tolerate a pid it cannot see', async () => {
    // Arrange
    const host = new FakeProc();
    host.directories.set(200, '/work/repository');

    // Act
    const own = await probeOver(host).workingDirectory(200);
    const absent = await probeOver(host).workingDirectory(0);

    // Assert
    should(own).equal('/work/repository');
    should(absent).be.undefined();
  });
});

describe('KernelProcessProbe, reading one subtree from procfs', () => {
  it('should walk only the subtree, in table order, as `ps` would print each row', async () => {
    // Act
    const actual = await probeOver(fakeProc()).descendants(100);

    // Assert
    should(actual).deepEqual([
      { pid: 200, ppid: 100, startedSecondsAgo: 500, argv: 'node x.js' },
      { pid: 201, ppid: 100, startedSecondsAgo: 10, argv: '[kw)x]' },
      { pid: 300, ppid: 100, startedSecondsAgo: 0, argv: 'echo a?b' },
    ]);
  });

  it('should hand the question back to the full table whenever procfs cannot answer it', async () => {
    // Arrange
    const noBootTime = new FakeProc().set('100/task/100/children', '');
    const badBootTime = fakeProc().set('stat', 'btime soon\n');

    // Act + Assert — no procfs, an unreadable root, no boot time, a boot time that is not a number.
    should(await probeOver(fakeProc(), undefined, { procfs: false }).descendants(100)).be.undefined();
    should(await probeOver(new FakeProc('darwin')).descendants(100)).be.undefined();
    should(await probeOver(fakeProc()).descendants(999)).be.undefined();
    should(await probeOver(noBootTime).descendants(100)).be.undefined();
    should(await probeOver(badBootTime).descendants(100)).be.undefined();
  });

  it('should let one table answer every ask inside its time-to-live, and never hold a failed read', async () => {
    // Arrange
    const clock = new DrivenClock(0);
    const working = new FakePs(() => printed('  2 1 00:01 init\n'));
    const failing = new FakePs(() => ({ exitCode: 1, signal: null, stdout: '', stderr: '' }));
    const options = { tableTtlMs: 1_000, procfs: false };
    const cached = new KernelProcessProbe(working, new FakeProc(), clock, options);
    const uncached = new KernelProcessProbe(failing, new FakeProc(), clock, options);

    // Act
    const first = await cached.processTable();
    clock.ms = 999;
    const held = await cached.processTable();
    clock.ms = 1_000;
    await cached.processTable();
    await uncached.processTable();
    await uncached.processTable();

    // Assert
    should(held).equal(first);
    should(working.calls).have.length(2);
    should(failing.calls).have.length(2);
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
    // every stopped codex session refuse its own move on evidence nobody could have produced.
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
  stdout: readFileSync(`${import.meta.dir}/../../../fixtures/ps/${name}`, 'utf8'),
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
      ...provenance,
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
      { ...provenance, servers },
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
    const files = new Map([
      [
        '/work/repository/.mcp.json',
        JSON.stringify({ mcpServers: { search: { command: 'npx', args: ['search-mcp'] } } }),
      ],
      ['/work/broken/.mcp.json', '{ not json'],
    ]);
    const reader = { readText: async (path: string): Promise<string | undefined> => files.get(path) };
    const subject = new ProjectMcpServers(reader);

    // Act
    const found = await subject.read('/work/repository');
    const broken = await subject.read('/work/broken');
    const missing = await subject.read('/work/absent');

    // Assert
    should(found).deepEqual([{ name: 'search', command: 'npx', args: ['search-mcp'] }]);
    should(broken).deepEqual([]);
    should(missing).deepEqual([]);
  });

  it('should explain nothing when the file cannot be read at all', async () => {
    // Arrange
    const subject = new ProjectMcpServers({
      readText: async () => {
        throw new Error('outside the work folder');
      },
    });

    // Act + Assert
    should(await subject.read('/elsewhere')).deepEqual([]);
  });
});

describe('KernelProcessProbe — which processes are servers', () => {
  const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const tcpRow = (state: string, inode: string): string =>
    `   0: 0100007F:1F90 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

  it('should name only the processes holding a LISTEN socket, from procfs', async () => {
    // Arrange — 201 listens on inode 5001; 202 holds an ESTABLISHED socket; 203 holds only a file.
    const host = new FakeProc()
      .set('net/tcp', [TCP_HEADER, tcpRow('0A', '5001'), tcpRow('01', '5002')].join('\n'))
      .set('net/tcp6', TCP_HEADER);
    host.links.set('201/3', 'socket:[5001]');
    host.links.set('202/3', 'socket:[5002]');
    host.links.set('203/3', '/dev/null');

    // Act
    const listening = await probeOver(host).listening([201, 202, 203, 204]);

    // Assert
    should([...(listening ?? [])]).deepEqual([201]);
  });

  it('should say it cannot tell where there is no procfs', async () => {
    // Act / Assert
    should(await probeOver(new FakeProc(), undefined, { procfs: false }).listening([1])).be.undefined();
  });

  it('should read the LISTEN inodes of a /proc/net/tcp table', () => {
    // Act / Assert
    should(listeningInodes([TCP_HEADER, tcpRow('0A', '7'), tcpRow('01', '8'), tcpRow('0A', '0')].join('\n'))).deepEqual(
      ['7'],
    );
  });
});

describe('KernelProcessProbe, looking up pids wherever they are', () => {
  it('should read each pid from procfs, whoever its parent is, and leave out the ones not running', async () => {
    // Act
    const actual = await probeOver(fakeProc()).lookup([200, 400, 999]);

    // Assert
    should([...actual.entries()]).deepEqual([
      [200, { pid: 200, ppid: 100, startedSecondsAgo: 500, argv: 'node x.js' }],
    ]);
  });

  it('should throw rather than answer "gone" when procfs gives no usable boot time', async () => {
    // Act
    const read = probeOver(fakeProc().set('stat', 'btime soon\n')).lookup([1]);

    // Assert
    await should(read).be.rejectedWith(/boot time/);
  });

  it('should read the table where there is no procfs, and throw when it cannot read one', async () => {
    // Arrange
    const ps = new FakePs(() => printed('  200 100 00:05 sleep 30\n  300   1 00:05 other\n'));
    const broken = new FakePs(() => ({ exitCode: 1, signal: null, stdout: '', stderr: 'cannot allocate memory' }));

    // Act
    const found = await probeOver(new FakeProc('darwin'), ps).lookup([200, 999]);
    const unreadable = probeOver(new FakeProc('darwin'), broken).lookup([1]);

    // Assert
    should([...found.keys()]).deepEqual([200]);
    await should(unreadable).be.rejectedWith('ps exited 1: cannot allocate memory');
  });
});
