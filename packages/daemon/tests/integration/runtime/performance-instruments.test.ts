import { describe, it } from 'bun:test';
import should from 'should';
import {
  countedFileOperations,
  instrumentChildProcesses,
  ProcessGauges,
  procIoSyscalls,
  procStatChildrenCpuMs,
  type SpawnHost,
  spawnedArgv,
} from '../../../src/adapters/runtime/performance-instruments.ts';
import { PerformanceRecorder } from '../../../src/lib/performance/recorder.ts';

const clock = { now: () => Date.now() };

describe('ProcessGauges', () => {
  it('should read the process counters, and the Linux ones where /proc answers', async () => {
    // Arrange
    const proc: Record<string, string> = {
      '/proc/self/io': 'rchar: 10\nwchar: 20\nsyscr: 7\nsyscw: 3\n',
      '/proc/self/stat': '42 (fy d (x)) S 1 42 42 0 -1 0 0 0 0 0 5 6 25 75 20 0 1 0',
    };
    const subject = new ProcessGauges('linux', async path => {
      const text = proc[path];
      if (text === undefined) throw new Error('absent');
      return text;
    });

    // Act
    const actual = await subject.read();

    // Assert
    should(actual.cpuUserMicros).be.aboveOrEqual(0);
    should(actual.rssBytes).be.above(0);
    should(actual.voluntaryContextSwitches).be.aboveOrEqual(0);
    should(actual.syscalls).deepEqual({ reads: 7, writes: 3 });
    should(actual.childrenCpuMs).equal(1_000);
  });

  it('should leave out what /proc does not answer, and everything Linux-only elsewhere', async () => {
    // Arrange
    const unreadable = new ProcessGauges('linux', async () => {
      throw new Error('no /proc');
    });
    const mac = new ProcessGauges('darwin');

    // Act
    const [linux, darwin] = await Promise.all([unreadable.read(), mac.read()]);

    // Assert
    should(linux).not.have.property('syscalls');
    should(linux).not.have.property('childrenCpuMs');
    should(darwin).not.have.property('syscalls');
    should(darwin.heapUsedBytes).be.above(0);
  });

  it('should read this real process on its own platform', async () => {
    // Act
    const actual = await new ProcessGauges().read();

    // Assert
    should(actual.externalBytes).be.aboveOrEqual(0);
    if (process.platform === 'linux') should(actual.syscalls?.reads).be.above(0);
  });
});

describe('the /proc parsers', () => {
  it.each([
    ['syscr: 1\nsyscw: 2\n', { reads: 1, writes: 2 }],
    ['syscr: 1\n', undefined],
    ['', undefined],
  ])('should read syscall counts from %j', (input, expected) => {
    // Act + Assert
    should(procIoSyscalls(input)).deepEqual(expected);
  });

  it.each([
    ['1 (a) S 1 1 1 0 -1 0 0 0 0 0 1 1 100 100', 2_000],
    ['no parenthesis at all', undefined],
    ['1 (a) S 1 1', undefined],
  ])('should read the reaped children’s CPU from %j', (input, expected) => {
    // Act + Assert
    should(procStatChildrenCpuMs(input)).equal(expected);
  });
});

describe('spawnedArgv', () => {
  it.each([
    [
      ['tmux', 'ls'],
      ['tmux', 'ls'],
    ],
    [{ cmd: ['git', 'status'] }, ['git', 'status']],
    [{ cwd: '/x' }, []],
    [undefined, []],
  ])('should read the command line of %j', (input, expected) => {
    // Act + Assert
    should(spawnedArgv(input)).deepEqual(expected);
  });
});

describe('instrumentChildProcesses', () => {
  it('should count real children by program and subcommand only while a profile records, then restore', async () => {
    // Arrange
    const recorder = new PerformanceRecorder();
    const host: SpawnHost = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
    const original = host.spawn;
    const restore = instrumentChildProcesses(recorder, clock, host);
    host.spawnSync(['true']);
    await host.spawn(['true']).exited;
    const window = recorder.open(clock.now());

    // Act
    await host.spawn(['/usr/bin/env', 'true', 'secret text']).exited;
    await host.spawn({ cmd: ['true', 'status'] }).exited;
    host.spawnSync(['true', '--flag']);
    // One macrotask turn drains the exit reactions the wrapper registered before this test awaited the same promises.
    await new Promise<void>(resolve => setImmediate(resolve));
    recorder.close(window);
    restore();

    // Assert
    const actual = window.tables(60_000).childProcesses;
    should(actual.total).equal(3);
    should(
      actual.commands
        .map(entry => [entry.command, entry.count, entry.synchronous])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).deepEqual([
      ['env true', 1, 0],
      ['true', 1, 1],
      ['true status', 1, 0],
    ]);
    should(actual.commands.every(entry => entry.wall.maxMs >= 0)).be.true();
    should(host.spawn).equal(original);
  });

  it('should attribute every real child to the labelled work running when it started', async () => {
    // Arrange
    const recorder = new PerformanceRecorder();
    const host: SpawnHost = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
    let running: string | undefined = 'turn watcher';
    const restore = instrumentChildProcesses(recorder, clock, host, () => running);
    const window = recorder.open(clock.now());

    // Act
    await host.spawn(['true']).exited;
    running = undefined;
    host.spawnSync(['true']);
    recorder.close(window);
    restore();

    // Assert
    should(window.tables(60_000).childProcesses.commands[0]?.by).deepEqual([
      { activity: '(no named work)', count: 1 },
      { activity: 'turn watcher', count: 1 },
    ]);
  });

  it('should leave a replacement installed after it in place when restoring', () => {
    // Arrange
    const host: SpawnHost = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
    const restore = instrumentChildProcesses(new PerformanceRecorder(), clock, host);
    const later = Bun.spawn;
    const laterSync = Bun.spawnSync;
    host.spawn = later;
    host.spawnSync = laterSync;

    // Act
    restore();

    // Assert
    should(host.spawn).equal(later);
    should(host.spawnSync).equal(laterSync);
  });

  it('should time a child whose exit rejects without recording an exit', async () => {
    // Arrange
    const recorder = new PerformanceRecorder();
    const exited = Promise.reject(new Error('gone'));
    exited.catch(() => undefined);
    const host = {
      spawn: (() => ({ exited })) as unknown as typeof Bun.spawn,
      spawnSync: Bun.spawnSync,
    };
    instrumentChildProcesses(recorder, clock, host);
    const window = recorder.open(0);

    // Act
    host.spawn(['tmux', 'ls']);
    // The rejection reaction is a microtask: one macrotask turn lets it run, so an exit WOULD be recorded by now.
    await new Promise<void>(resolve => setImmediate(resolve));

    // Assert
    const [entry] = window.tables(60_000).childProcesses.commands;
    should(entry?.count).equal(1);
    should(entry?.wall.maxMs).equal(0);
  });
});

class StatePort {
  readonly #root = '/home/me';
  readText(path: string): Promise<string> {
    return Promise.resolve(`${this.#root}:${path}`);
  }
  exists(path: string): boolean {
    return path.length > 0;
  }
  fail(path: string): void {
    throw new Error(`no ${path}`);
  }
  rejects(path: string): Promise<void> {
    return Promise.reject(new Error(`no ${path}`));
  }
  count(times: number): number {
    return times;
  }
  readonly label = 'state';
}

describe('countedFileOperations', () => {
  it('should count every path call by shape and pass everything through', async () => {
    // Arrange
    const recorder = new PerformanceRecorder();
    const subject = countedFileOperations(new StatePort(), 'state', recorder, clock, { home: '/home/me' });
    const window = recorder.open(0);

    // Act
    const text = await subject.readText('/home/me/.ferretry/state/sessions/mvir1r5g-90731a4e/state.json');
    const exists = subject.exists('/home/me/.ferretry/config/daemon.json');
    should(() => subject.fail('/home/me/.ferretry/x')).throw(/no/);
    await should(subject.rejects('/home/me/.ferretry/y')).be.rejectedWith(/no/);
    const count = subject.count(3);
    recorder.close(window);

    // Assert
    should(text).startWith('/home/me:');
    should(exists).be.true();
    should(count).equal(3);
    should(subject.label).equal('state');
    should(subject.readText).equal(subject.readText);
    const actual = window
      .tables(1_000)
      .fileOperations.top.map(entry => `${entry.operation} ${entry.path} ${String(entry.count)}`)
      .sort();
    should(actual).deepEqual([
      'state.exists ~/.ferretry/config/daemon.json 1',
      'state.fail ~/.ferretry/x 1',
      'state.readText ~/.ferretry/state/sessions/<session>/state.json 1',
      'state.rejects ~/.ferretry/y 1',
    ]);
  });

  it('should count nothing while no profile records', async () => {
    // Arrange
    const recorder = new PerformanceRecorder();
    const subject = countedFileOperations(new StatePort(), 'state', recorder, clock, { home: '/home/me' });

    // Act
    await subject.readText('/home/me/.ferretry/a');
    const window = recorder.open(0);

    // Assert
    should(window.tables(1_000).fileOperations.total).equal(0);
  });
});
