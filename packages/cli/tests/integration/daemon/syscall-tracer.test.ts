import { describe, it } from 'bun:test';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import { bunTracerHost, PlatformSyscallTracer, type TracerHost } from '../../../src/adapters/daemon/syscall-tracer.ts';

const STRACE = [
  '101 openat(AT_FDCWD, "/home/me/.ferretry/state/sessions/mvir1r5g-90731a4e/state.json", O_RDONLY) = 3',
  '101 execve("/nix/store/abc-tmux/bin/tmux", ["tmux", "-u", "-S", "/x.sock", "capture-pane"], 0x0 /* 3 vars */) = 0',
].join('\n');
const FS_USAGE = '12:00:01.000001  open  F=4  (R_____)  /Users/me/.ferretry/config/daemon.json  0.000010  fyd.12';

/** A host whose every part is scripted, recording what it was asked to run. */
function host(overrides: Partial<TracerHost> = {}): TracerHost & { readonly ran: string[][] } {
  const ran: string[][] = [];
  let file = '';
  return {
    ran,
    platform: 'linux',
    home: '/home/me',
    mayPtrace: async () => true,
    which: program => `/usr/bin/${program}`,
    interactive: async argv => {
      ran.push([...argv]);
      return 0;
    },
    traceFor: async argv => {
      ran.push([...argv]);
      const output = argv.indexOf('-o');
      if (output >= 0) file = argv[output + 1] ?? '';
      return { code: 0, stdout: argv.includes('/usr/bin/fs_usage') ? FS_USAGE : '', stderr: '' };
    },
    scratchFile: async () => '/tmp/trace.txt',
    readText: async path => {
      should(path).equal(file);
      return STRACE;
    },
    remove: async () => undefined,
    ...overrides,
  };
}

describe('PlatformSyscallTracer', () => {
  it('should trace with strace directly when ptrace is allowed, and reduce the output to shapes', async () => {
    // Arrange
    const scripted = host();
    const subject = new PlatformSyscallTracer(scripted);

    // Act
    const prepared = await subject.prepare();
    const actual = await subject.trace(42, 10);

    // Assert
    should(prepared).be.undefined();
    should(scripted.ran).deepEqual([
      ['strace', '-f', '-qq', '-s', '256', '-e', 'trace=%file,execve', '-o', '/tmp/trace.txt', '-p', '42'],
    ]);
    if (actual.kind !== 'traced') throw new Error(actual.reason);
    should(actual.trace.top).deepEqual([
      { call: 'openat', path: '~/.ferretry/state/sessions/<session>/state.json', count: 1, perSecond: 0.1 },
    ]);
    should(actual.trace.executions).deepEqual([{ command: 'tmux capture-pane', count: 1 }]);
  });

  it('should ask for sudo first when ptrace is restricted, and trace under it', async () => {
    // Arrange
    const scripted = host({ mayPtrace: async () => false });
    const subject = new PlatformSyscallTracer(scripted);

    // Act
    const prepared = await subject.prepare();
    await subject.trace(7, 5);

    // Assert
    should(prepared).be.undefined();
    should(scripted.ran[0]).deepEqual(['sudo', '-v']);
    should(scripted.ran[1]?.slice(0, 3)).deepEqual(['sudo', '-n', 'strace']);
  });

  it('should trace macOS with sudo fs_usage', async () => {
    // Arrange
    const scripted = host({ platform: 'darwin', home: '/Users/me' });
    const subject = new PlatformSyscallTracer(scripted);

    // Act
    await subject.prepare();
    const actual = await subject.trace(12, 2);

    // Assert
    should(scripted.ran[1]).deepEqual(['sudo', '-n', '/usr/bin/fs_usage', '-w', '-f', 'filesys', '-f', 'exec', '12']);
    if (actual.kind !== 'traced') throw new Error(actual.reason);
    should(actual.trace.tool).equal('fs_usage');
    should(actual.trace.top[0]?.path).equal('~/.ferretry/config/daemon.json');
  });

  it.each([
    [
      'strace is missing',
      host({ which: program => (program === 'strace' ? null : '/usr/bin/sudo') }),
      /strace is not installed/,
    ],
    ['the platform has no tracer', host({ platform: 'win32' }), /no system-call tracer for win32/],
    [
      'sudo is missing',
      host({ mayPtrace: async () => false, which: program => (program === 'sudo' ? null : '/usr/bin/strace') }),
      /sudo is not installed/,
    ],
    ['sudo is refused', host({ platform: 'darwin', interactive: async () => 1 }), /sudo was refused/],
  ])('should say why it cannot trace when %s', async (_name, scripted, expected) => {
    // Act
    const actual = await new PlatformSyscallTracer(scripted).prepare();

    // Assert
    if (actual?.kind !== 'unavailable') throw new Error('expected a refusal');
    should(actual.reason).match(expected);
  });

  it('should say so, and run nothing, when it has nowhere private to write the trace', async () => {
    // Arrange
    const scripted = host({
      scratchFile: async () => {
        throw new Error('EACCES');
      },
    });

    // Act
    const actual = await new PlatformSyscallTracer(scripted).trace(1, 1);

    // Assert
    should(actual).deepEqual({ kind: 'unavailable', reason: 'there was nowhere private to write the trace' });
    should(scripted.ran).deepEqual([]);
  });

  it('should say a trace recorded nothing, with the tracer’s first words or its exit', async () => {
    // Arrange
    const quietStrace = host({
      traceFor: async () => ({ code: 1, stdout: '', stderr: '\nstrace: attach: Operation not permitted\n' }),
      readText: async () => {
        throw new Error('no file');
      },
    });
    const quietFsUsage = host({ platform: 'darwin', traceFor: async () => ({ code: 3, stdout: ' ', stderr: '' }) });

    // Act
    const strace = await new PlatformSyscallTracer(quietStrace).trace(1, 1);
    const fsUsage = await new PlatformSyscallTracer(quietFsUsage).trace(1, 1);

    // Assert
    should(strace).deepEqual({
      kind: 'unavailable',
      reason: 'strace recorded nothing (strace: attach: Operation not permitted)',
    });
    should(fsUsage).deepEqual({ kind: 'unavailable', reason: 'fs_usage recorded nothing (exit 3)' });
  });
});

describe('bunTracerHost', () => {
  it('should run real processes: an interactive one, and a traced one stopped after its seconds', async () => {
    // Arrange
    const state = await mkdtemp(join(tmpdir(), 'fy-tracer-state-'));
    const subject = bunTracerHost(state);
    const file = join(state, `fy-tracer-${String(process.pid)}.txt`);
    await writeFile(file, 'traced');

    try {
      // Act
      const interactive = await subject.interactive(['true']);
      const traced = await subject.traceFor(['sh', '-c', 'echo started; sleep 30'], 1);
      const text = await subject.readText(file);
      await rm(file, { force: true });
      const allowed = await subject.mayPtrace();

      // Assert
      should(interactive).equal(0);
      should(traced.stdout).equal('started\n');
      should(text).equal('traced');
      should(allowed).be.a.Boolean();
      should(subject.which('sh')).not.be.null();
      should(subject.platform).equal(process.platform);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  }, 10_000);

  it('should write the trace into a fresh private directory under the state home, not the shared tmp', async () => {
    // Arrange
    const state = await mkdtemp(join(tmpdir(), 'fy-tracer-state-'));
    const subject = bunTracerHost(state);

    try {
      // Act
      const first = await subject.scratchFile();
      const second = await subject.scratchFile();
      const modes = await Promise.all(
        [first, second]
          .flatMap(file => [stat(dirname(file)), stat(file)])
          .map(async pending => (await pending).mode & 0o777),
      );

      // Assert
      for (const file of [first, second]) {
        should(file.startsWith(`${state}/trace/fy-trace-`)).be.true();
        should(file.startsWith(`${tmpdir()}/fy-trace-`)).be.false();
      }
      should(dirname(first)).not.equal(dirname(second));
      // Directory 0700 so no other user can reach the file, and the file itself 0600 so a later
      // loosening of the directory still does not expose it.
      should(modes).deepEqual([0o700, 0o600, 0o700, 0o600]);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

  it('should remove the whole private directory with the trace', async () => {
    // Arrange
    const state = await mkdtemp(join(tmpdir(), 'fy-tracer-state-'));
    const subject = bunTracerHost(state);

    try {
      const file = await subject.scratchFile();

      // Act
      await subject.remove(file);

      // Assert
      should(await readdir(join(state, 'trace'))).deepEqual([]);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });
});
