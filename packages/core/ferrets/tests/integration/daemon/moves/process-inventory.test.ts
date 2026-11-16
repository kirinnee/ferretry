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
} from '../../../../daemon/adapters/moves/process-inventory.ts';
import type { ConfiguredServer } from '../../../../daemon/lib/moves/harness-provenance.ts';
import type {
  MovePane,
  ProcessProbePort,
  ProcessTableRead,
} from '../../../../daemon/lib/moves/process-inventory-port.ts';
import type { RunnerPaneIdentity } from '../../../../contract/index.ts';

/**
 * A pane as its runner reports it: the identity it answers (`'gone'` when PROVED absent, `undefined` when it cannot tell, a
 * thrown error when it breaks) and the screen it shows. The inventory addresses a pane only through this.
 */
function pane(
  identity: RunnerPaneIdentity | 'gone' | undefined | Error,
  screen = '',
): MovePane & { readonly asked: number } {
  const state = { asked: 0 };
  return {
    get asked() {
      return state.asked;
    },
    identify: async () => {
      state.asked += 1;
      if (identity instanceof Error) throw identity;
      return identity;
    },
    screen: async () => screen,
  };
}

/** A live pane whose root is `pid`. */
const livePane = (pid: number) =>
  pane({ handle: '%3' as RunnerPaneIdentity['handle'], pid, processStart: '1792626406' });

/** The inventory over a probe, reading the pane it is handed (a test says which; there is no session name to look up). */
const inventory = (
  target: MovePane,
  probe: ProcessProbePort,
  provenanceOf: ConstructorParameters<typeof PaneProcessInventory>[1],
) => ({
  collect: async (_name?: string) => await new PaneProcessInventory(probe, provenanceOf).collect(target),
});

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
  it('should inspect only the descendants of the root the runner names', async () => {
    // Arrange
    const target = livePane(100);
    const probe = new FakeProbe(table('100 1 50 harness\n200 100 20 npm test\n300 1 10 unrelated'));

    // Act
    const actual = await inventory(target, probe, provenance).collect();

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
    should(target.asked).equal(1);
    should(probe.workingDirectoryCalls).deepEqual([200, 100]);
  });

  it('should report a pane the runner cannot place as unobservable, a blind spot the gate refuses on', async () => {
    // A runner with no `identify`, or one that cannot tell, is not "no work": something may run under a pane nobody could inspect.
    // Arrange
    const target = pane(undefined);

    // Act
    const actual = await inventory(target, new FakeProbe(table('')), provenance).collect();

    // Assert
    should(actual).deepEqual({
      kind: 'unobservable',
      reason: 'the runner could not say which process the pane runs',
    });
  });

  it('should report a pane the runner PROVES gone as an empty observation, not a blind spot', async () => {
    // THE COMMONEST MOVE THERE IS. A ferret whose account died has no pane at all, and "I could not look" would refuse the very
    // move the operator is trying to make. Only a pane the runner proves absent ran nothing.
    // Arrange
    const probe = new FakeProbe(table(''));

    // Act
    const actual = await inventory(pane('gone'), probe, provenance).collect();

    // Assert
    should(actual).deepEqual({ kind: 'observed', processes: [] });
    should(probe.workingDirectoryCalls).deepEqual([]);
  });

  it('should report a dead pane the runner keeps as running nothing, with no pid to look under', async () => {
    // Arrange — a dead pane has no root process; its identity carries a handle and nothing else.
    const target = pane({ handle: '%3' as RunnerPaneIdentity['handle'] });
    const probe = new FakeProbe(table(''));

    // Act
    const actual = await inventory(target, probe, provenance).collect();

    // Assert — observed, not a blind spot, and no process was looked for.
    should(actual).deepEqual({ kind: 'observed', processes: [] });
    should(probe.workingDirectoryCalls).deepEqual([]);
  });

  it('should surface a failed process-table read as the blind spot it is', async () => {
    // Arrange
    const probe = new FakeProbe({ kind: 'failed', reason: 'ps exited 1: cannot allocate memory' });

    // Act
    const actual = await inventory(livePane(100), probe, provenance).collect();

    // Assert
    should(actual).deepEqual({
      kind: 'unobservable',
      reason: 'the process table could not be read: ps exited 1: cannot allocate memory',
    });
  });

  it('should report a runner that breaks as a blind spot, never as an empty pane', async () => {
    // Arrange
    const target = pane(new Error('the runner is not running'));

    // Act
    const actual = await inventory(target, new FakeProbe(table('')), provenance).collect();

    // Assert
    should(actual).deepEqual({
      kind: 'unobservable',
      reason: 'the pane could not be inspected: the runner is not running',
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
      { pid: 200, ppid: 100, startedSecondsAgo: 500, argv: 'node x.js', command: 'node x.js' },
      { pid: 201, ppid: 100, startedSecondsAgo: 10, argv: '[kw)x]' },
      // The display copy has the newline as `?`; the exact command keeps it, so a multi-line command can be judged per line.
      { pid: 300, ppid: 100, startedSecondsAgo: 0, argv: 'echo a?b', command: 'echo a\nb' },
    ]);
  });

  describe('a multi-line Claude tool command', () => {
    const wrapper = (payload: string): string =>
      "/usr/bin/zsh\0-c\0source /h/shell-snapshots/snapshot-zsh-1-ab.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval '" +
      payload +
      "' < /dev/null && pwd -P >| /tmp/claude-99ff-cwd\0";
    const MULTI_LINE = 'echo start\ngit stash\nbun test\ngit stash pop';
    const pane = (): FakeProc =>
      new FakeProc()
        .set('stat', `cpu 1 2 3\nbtime ${String(BOOT_SECONDS)}\n`)
        .set('100/task/100/children', '200')
        .set('200/stat', stat(200, 'zsh', 100, 50_000))
        .set('200/cmdline', wrapper(MULTI_LINE));
    const paneInventory = (probe: ProcessProbePort) => inventory(livePane(100), probe, provenance);

    it('should judge EVERY line when the kernel gave the words (the stash in the middle is seen)', async () => {
      // Act
      const observed = await paneInventory(probeOver(pane())).collect('session-1');

      // Assert — judged by its first line alone this was `echo`: safe_to_kill, and the gate passed.
      should(observed).containDeep({
        kind: 'observed',
        processes: [{ pid: 200, verdict: 'destructive_to_interrupt' }],
      });
    });

    it('should refuse to unwrap the lossy `ps` form, whose newlines are already `?`', async () => {
      // Arrange — what `ps` prints for the same process: every control character is a `?`.
      const lossy = wrapper(MULTI_LINE).replaceAll('\0', ' ').replaceAll('\n', '?').trim();
      const probe = new FakeProbe(table(`100 1 50 harness\n200 100 20 ${lossy}`));

      // Act
      const observed = await paneInventory(probe).collect('session-1');

      // Assert — not unwrapped, so not judged by `echo start`: it blocks.
      should(observed).containDeep({ kind: 'observed', processes: [{ pid: 200, verdict: 'unknown' }] });
    });
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
    const target = livePane(100);
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
    const actual = await inventory(target, probe, provenance).collect('fy-session');

    // Assert
    should(actual).match({ kind: 'observed', processes: [{ pid: 200, argv: 'sleep 30', cwd: '/work' }] });
    should(tables).equal(0);
  });

  it('should read the full table when the probe cannot read the subtree', async () => {
    // Arrange
    const target = livePane(100);
    const probe: ProcessProbePort = {
      processTable: async () => table('  200   100 00:05 sleep 30\n  300     1 00:05 other\n'),
      descendants: async () => undefined,
      workingDirectory: async () => '/work',
    };

    // Act
    const actual = await inventory(target, probe, provenance).collect('fy-session');

    // Assert
    should(actual).match({ kind: 'observed', processes: [{ pid: 200, argv: 'sleep 30' }] });
  });
});

const fixtureTable = (name: string): ProcessTableRead => ({
  kind: 'read',
  stdout: readFileSync(`${import.meta.dir}/../../../fixtures/ps/${name}`, 'utf8'),
});

describe('PaneProcessInventory, over real process tables', () => {
  it('should not call the harness’s own Ferretry tools server unknown (the owner’s refusal)', async () => {
    // Arrange — `claude` IS the pane process here, as tmux reports it, and `fy mcp serve` is its child.
    const target = livePane(3887833);
    const probe = new FakeProbe(fixtureTable('linux-owner-case.txt'));

    // Act
    const actual = await inventory(target, probe, provenance).collect('fy-session');

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
    const target = livePane(412);
    const asked: string[] = [];
    const servers = {
      read: async (directory: string): Promise<readonly ConfiguredServer[]> => {
        asked.push(directory);
        return [{ name: 'search', command: 'npx', args: ['-y', '@acme/search-mcp@latest'] }];
      },
    };

    // Act
    const actual = await inventory(target, new FakeProbe(fixtureTable('macos-claude-pane.txt')), {
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
    const target = livePane(412);
    const servers = {
      read: async (): Promise<readonly ConfiguredServer[]> => {
        throw new Error('must not be asked');
      },
    };

    // Act
    const actual = await inventory(
      target,
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
      [200, { pid: 200, ppid: 100, startedSecondsAgo: 500, argv: 'node x.js', command: 'node x.js' }],
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

describe('PaneProcessInventory and the job keeper on the gate path', () => {
  const rows = table('100 1 50 claude\n200 100 20 fy job attach build');
  const collect = async (attachments: () => Promise<never[] | { pid: number; jobId: string; jobName: string }[]>) =>
    await new PaneProcessInventory(new FakeProbe(rows), {
      ...provenance,
      attachments,
      keeperTimeoutMs: 20,
      sleep: async ms => await new Promise<void>(done => setTimeout(done, ms)),
    }).collect(livePane(100), 'ferret-a');
  const attach = (observed: Awaited<ReturnType<typeof collect>>) =>
    observed.kind === 'observed' ? observed.processes.find(entry => entry.pid === 200) : undefined;

  it('should know the attachment the keeper proves', async () => {
    const found = attach(await collect(async () => [{ pid: 200, jobId: 'abc', jobName: 'build' }]));
    should(found?.known?.kind).equal('job-attachment');
  });

  it('should fail closed when the keeper does not answer in time: no attachment is proven, the classifier decides', async () => {
    const found = attach(await collect(async () => await new Promise<never>(() => undefined)));
    should(found?.known).be.undefined();
    should(found?.verdict).not.equal('safe_to_kill');
  });
});
