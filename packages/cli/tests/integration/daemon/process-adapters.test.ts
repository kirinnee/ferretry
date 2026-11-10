import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { TailDaemonLog } from '../../../src/adapters/daemon/log-stream.ts';
import { HostProcessIncarnations } from '../../../src/adapters/daemon/process-incarnation.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import type { CommandOutcome, IDaemonProcessPort } from '../../../src/lib/daemon/ports.ts';
import { waitFor } from '../support/wait-for.ts';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-proc-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async dir => await rm(dir, { recursive: true, force: true })));
});

/** A script in `dir` that prints `stdout` and exits `code`, standing in for lsof, ps or sysctl. */
async function script(dir: string, name: string, stdout: string, code: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${String(code)}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

describe('running a command and capturing what it says', () => {
  const processes = new BunDaemonProcess();

  it('should return the exit code and both streams of a command that ran', async () => {
    const outcome = await processes.run(['sh', '-c', 'printf out; printf err >&2; exit 3']);
    should(outcome).eql({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('should answer 127 with the reason when the command does not exist, instead of throwing', async () => {
    const outcome = await processes.run(['/nonexistent/fy-no-such-command']);
    should(outcome.code).equal(127);
    should(outcome.stderr).not.equal('');
  });

  it('should refuse an empty command', async () => {
    await should(processes.run([])).rejectedWith('cannot run an empty command');
    await should(processes.runStreaming([])).rejectedWith('cannot run an empty command');
    await should(processes.spawnDetached({ argv: [], environment: {}, logFile: '/nonexistent/log' })).rejectedWith(
      'cannot launch an empty command',
    );
  });

  it('should hand each output line to the callback as it is written, ending lines at newline or carriage return', async () => {
    const lines: string[] = [];
    const outcome = await processes.runStreaming(
      ['sh', '-c', 'printf "one\\rtwo\\nthree\\n\\nfour"; printf warn >&2'],
      line => lines.push(line),
    );
    should(outcome.code).equal(0);
    should(outcome.stdout).equal('one\rtwo\nthree\n\nfour');
    should(outcome.stderr).equal('warn');
    should(lines.toSorted()).eql(['four', 'one', 'three', 'two', 'warn']);
  });

  it('should return the whole output of a streamed command when nobody listens for lines', async () => {
    const outcome = await processes.runStreaming(['sh', '-c', 'printf quiet']);
    should(outcome).eql({ code: 0, stdout: 'quiet', stderr: '' });
  });

  it('should answer 127 for a streamed command that does not exist', async () => {
    const outcome = await processes.runStreaming(['/nonexistent/fy-no-such-command']);
    should(outcome.code).equal(127);
    should(outcome.stdout).equal('');
  });
});

describe('starting a daemon detached with its output appended to the log', () => {
  it('should append what the child prints to the log, pass only the given environment, and report its pid', async () => {
    const dir = await temp();
    const logFile = join(dir, 'daemon.log');
    await writeFile(logFile, 'before\n');
    const processes = new BunDaemonProcess();
    const handle = await processes.spawnDetached({
      argv: ['sh', '-c', 'printf "env=%s\\n" "$FY_PROBE"; printf "home=%s\\n" "${HOME-unset}"'],
      environment: { FY_PROBE: 'given' },
      logFile,
    });
    should(handle.pid).be.above(0);
    await waitFor(async () => (await readFile(logFile, 'utf8')).includes('home='), 'the detached child to log');
    should(await readFile(logFile, 'utf8')).equal('before\nenv=given\nhome=unset\n');
  });
});

describe('signalling and probing a process', () => {
  const processes = new BunDaemonProcess();

  it('should see this very process as alive and a process that has exited as not', async () => {
    should(processes.alive(process.pid)).be.true();
    const child = Bun.spawn(['sh', '-c', 'exit 0']);
    await child.exited;
    should(processes.alive(child.pid)).be.false();
  });

  it('should terminate a running child and say so, and say false for one already gone', async () => {
    const child = Bun.spawn(['sleep', '30']);
    should(processes.signal(child.pid, 'SIGTERM')).be.true();
    await child.exited;
    should(processes.signal(child.pid, 'SIGKILL')).be.false();
  });
});

describe('whether a process holds a file open', () => {
  it('should find this process holding a file it opened, and not holding one it did not, on the host /proc', async () => {
    const dir = await temp();
    const held = join(dir, 'held.log');
    const other = join(dir, 'other.log');
    await writeFile(held, '');
    await writeFile(other, '');
    const handle = await open(held, 'r');
    try {
      const processes = new BunDaemonProcess();
      should(await processes.holdsOpen(process.pid, held)).be.true();
      should(await processes.holdsOpen(process.pid, other)).be.false();
    } finally {
      await handle.close();
    }
  });

  it('should say a file nobody ever created is held by nobody', async () => {
    const dir = await temp();
    should(await new BunDaemonProcess().holdsOpen(process.pid, join(dir, 'missing.log'))).be.false();
  });

  it('should say false for a process that no longer exists and undefined for one it may not look inside', async () => {
    const dir = await temp();
    const file = join(dir, 'file.log');
    await writeFile(file, '');
    const proc = join(dir, 'proc');
    await mkdir(join(proc, 'self', 'fd'), { recursive: true });
    // pid 7 has a file where its fd directory should be: a listing that fails with something other than ENOENT.
    await mkdir(join(proc, '7'), { recursive: true });
    await writeFile(join(proc, '7', 'fd'), '');
    const processes = new BunDaemonProcess({ procDirectory: proc });
    should(await processes.holdsOpen(8, file)).be.false();
    should(await processes.holdsOpen(7, file)).be.undefined();
  });

  it('should skip a descriptor that cannot be read and find the one that names the file', async () => {
    const dir = await temp();
    const file = join(dir, 'file.log');
    await writeFile(file, '');
    const proc = join(dir, 'proc');
    await mkdir(join(proc, 'self', 'fd'), { recursive: true });
    await mkdir(join(proc, '9', 'fd'), { recursive: true });
    await writeFile(join(proc, '9', 'fd', '0'), 'not a link');
    const processes = new BunDaemonProcess({ procDirectory: proc });
    should(await processes.holdsOpen(9, file)).be.false();
    await symlink(file, join(proc, '9', 'fd', '1'));
    should(await processes.holdsOpen(9, file)).be.true();
  });

  it('should ask lsof where there is no /proc, and read its answer for the pid', async () => {
    const dir = await temp();
    const target = join(dir, 'file.log');
    const none = join(dir, 'no-proc');
    const holds = await script(dir, 'lsof-holds', '41\n42\n', 0);
    const nothing = await script(dir, 'lsof-nothing', '', 1);
    const someoneElse = await script(dir, 'lsof-else', '99\n', 0);
    should(await new BunDaemonProcess({ procDirectory: none, lsof: holds }).holdsOpen(42, target)).be.true();
    should(await new BunDaemonProcess({ procDirectory: none, lsof: nothing }).holdsOpen(42, target)).be.false();
    should(await new BunDaemonProcess({ procDirectory: none, lsof: someoneElse }).holdsOpen(42, target)).be.false();
  });

  it('should say undefined when the host has neither /proc nor lsof', async () => {
    const dir = await temp();
    const processes = new BunDaemonProcess({ procDirectory: join(dir, 'no-proc'), lsof: join(dir, 'no-lsof') });
    should(await processes.holdsOpen(1, join(dir, 'file.log'))).be.undefined();
  });
});

/** A runner whose only job is to answer the sysctl and ps questions the incarnation reader asks. */
function runner(answer: (argv: readonly string[]) => CommandOutcome): IDaemonProcessPort {
  return {
    run: async argv => await Promise.resolve(answer(argv)),
    spawnDetached: async () => await Promise.reject(new Error('unused')),
    signal: () => false,
    alive: () => false,
    holdsOpen: async () => await Promise.resolve(undefined),
  };
}

/** A stat line whose field 22 (start time) is `start`, with a command name that itself holds spaces and a parenthesis. */
function statLine(pid: number, start: string): string {
  const after = Array.from({ length: 24 }, (_, index) => (index === 19 ? start : '0'));
  after[0] = 'S';
  return `${String(pid)} (we ird) name) ${after.join(' ')}\n`;
}

async function fakeProc(root: string, boot: string, namespace: string | undefined): Promise<string> {
  const proc = join(root, 'proc');
  await mkdir(join(proc, 'sys', 'kernel', 'random'), { recursive: true });
  await mkdir(join(proc, 'self', 'ns'), { recursive: true });
  await writeFile(join(proc, 'sys', 'kernel', 'random', 'boot_id'), `${boot}\n`);
  await writeFile(join(proc, 'self', 'stat'), statLine(1, '1'));
  if (namespace !== undefined) await symlink(namespace, join(proc, 'self', 'ns', 'pid'));
  return proc;
}

describe('which process a pid number means', () => {
  const never = runner(() => {
    throw new Error('the service manager must not be asked on a host with /proc');
  });

  it('should name this host boot and PID namespace, and see this process running, from the real /proc', async () => {
    const incarnations = new HostProcessIncarnations(new BunDaemonProcess());
    const scope = await incarnations.scope();
    should(scope?.boot).be.a.String().and.not.equal('');
    const mine = await incarnations.observe(process.pid);
    should(mine.kind).equal('running');
    // A different number of the same process never reads as the same start time.
    const again = await incarnations.observe(process.pid);
    should(again).eql(mine);
  });

  it('should read the boot id and namespace link of a /proc, and the start time past a command name with parentheses', async () => {
    const root = await temp();
    const proc = await fakeProc(root, 'boot-one', 'pid:[4026531836]');
    await mkdir(join(proc, '321'));
    await writeFile(join(proc, '321', 'stat'), statLine(321, '98765'));
    const incarnations = new HostProcessIncarnations(never, { procDirectory: proc });
    should(await incarnations.scope()).eql({ boot: 'boot-one', namespace: 'pid:[4026531836]' });
    should(await incarnations.observe(321)).eql({ kind: 'running', start: '98765' });
  });

  it('should have no scope when /proc names no namespace or an empty boot', async () => {
    const root = await temp();
    const noNamespace = await fakeProc(join(root, 'a'), 'boot-one', undefined);
    should(await new HostProcessIncarnations(never, { procDirectory: noNamespace }).scope()).be.undefined();
    const emptyBoot = await fakeProc(join(root, 'b'), '', 'pid:[1]');
    should(await new HostProcessIncarnations(never, { procDirectory: emptyBoot }).scope()).be.undefined();
  });

  it('should call a pid with no /proc entry gone, and one with an unusable stat unknown', async () => {
    const root = await temp();
    const proc = await fakeProc(root, 'boot-one', 'pid:[1]');
    await mkdir(join(proc, '5'));
    await writeFile(join(proc, '5', 'stat'), statLine(5, 'not-a-number'));
    await mkdir(join(proc, '6', 'stat'), { recursive: true });
    await mkdir(join(proc, '7'));
    await writeFile(join(proc, '7', 'stat'), 'garbage');
    const incarnations = new HostProcessIncarnations(never, { procDirectory: proc });
    should(await incarnations.observe(4)).eql({ kind: 'gone' });
    should(await incarnations.observe(5)).eql({ kind: 'unknown' });
    should(await incarnations.observe(6)).eql({ kind: 'unknown' });
    should(await incarnations.observe(7)).eql({ kind: 'unknown' });
  });

  it('should take the boot session from sysctl where there is no /proc, and nothing when sysctl fails or says nothing', async () => {
    const root = await temp();
    const none = join(root, 'no-proc');
    const asked: (readonly string[])[] = [];
    const ok = new HostProcessIncarnations(
      runner(argv => {
        asked.push(argv);
        return { code: 0, stdout: ' UUID-1 \n', stderr: '' };
      }),
      { procDirectory: none, sysctl: 'fake-sysctl' },
    );
    should(await ok.scope()).eql({ boot: 'UUID-1', namespace: 'darwin' });
    should(asked).eql([['fake-sysctl', '-n', 'kern.bootsessionuuid']]);
    const failed = new HostProcessIncarnations(
      runner(() => ({ code: 1, stdout: 'UUID-1', stderr: '' })),
      { procDirectory: none },
    );
    should(await failed.scope()).be.undefined();
    const empty = new HostProcessIncarnations(
      runner(() => ({ code: 0, stdout: '\n', stderr: '' })),
      { procDirectory: none },
    );
    should(await empty.scope()).be.undefined();
  });

  it('should read a process start time from ps where there is no /proc', async () => {
    const root = await temp();
    const none = join(root, 'no-proc');
    const answers: Record<string, CommandOutcome> = {
      '10': { code: 0, stdout: 'Sat Nov  8 10:00:00 2026\n', stderr: '' },
      '11': { code: 1, stdout: '', stderr: '' },
      '12': { code: 127, stdout: '', stderr: 'ps: not found' },
      '13': { code: 2, stdout: '', stderr: 'bad' },
      '14': { code: 0, stdout: '\n', stderr: '' },
    };
    const incarnations = new HostProcessIncarnations(
      runner(argv => answers[argv.at(-1) ?? ''] ?? { code: 127, stdout: '', stderr: '' }),
      { procDirectory: none, ps: 'fake-ps' },
    );
    should(await incarnations.observe(10)).eql({ kind: 'running', start: 'Sat Nov  8 10:00:00 2026' });
    should(await incarnations.observe(11)).eql({ kind: 'gone' });
    should(await incarnations.observe(12)).eql({ kind: 'unknown' });
    should(await incarnations.observe(13)).eql({ kind: 'unknown' });
    should(await incarnations.observe(14)).eql({ kind: 'unknown' });
  });
});

describe('streaming the daemon log to the terminal', () => {
  /** Run `body` while this process's standard output is captured, then put it back. */
  async function capturing(
    body: () => Promise<void>,
    failWith?: Error,
  ): Promise<{ readonly text: string; readonly writes: number }> {
    const original = process.stdout.write.bind(process.stdout);
    const chunks: Uint8Array[] = [];
    process.stdout.write = ((chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean => {
      chunks.push(chunk);
      callback?.(failWith ?? null);
      return true;
    }) as typeof process.stdout.write;
    try {
      await body();
    } finally {
      process.stdout.write = original;
    }
    return { text: Buffer.concat(chunks).toString('utf8'), writes: chunks.length };
  }

  it('should say whether the log file exists', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'daemon.log'), 'x');
    const log = new TailDaemonLog();
    should(await log.exists(join(dir, 'daemon.log'))).be.true();
    should(await log.exists(join(dir, 'missing.log'))).be.false();
  });

  it('should relay the whole log to standard output and report the reader exit code', async () => {
    const dir = await temp();
    const logFile = join(dir, 'daemon.log');
    await writeFile(logFile, 'first line\nsecond line\n');
    let code = -1;
    const { text } = await capturing(async () => {
      code = await new TailDaemonLog().show(logFile, false);
    });
    should(text).equal('first line\nsecond line\n');
    should(code).equal(0);
  });

  it('should pass the reader failure code on when the log cannot be read', async () => {
    const dir = await temp();
    let code = 0;
    await capturing(async () => {
      code = await new TailDaemonLog().show(join(dir, 'missing.log'), false);
    });
    should(code).not.equal(0);
  });

  it('should treat a reader that went away as a normal end rather than an error', async () => {
    const dir = await temp();
    const logFile = join(dir, 'daemon.log');
    await writeFile(logFile, 'a line the reader no longer wants\n');
    let code = -1;
    await capturing(async () => {
      code = await new TailDaemonLog().show(logFile, false);
    }, new Error('EPIPE'));
    should(code).equal(0);
  });

  it('should follow by name from the first line with tail -F, and read once with cat otherwise', async () => {
    const argvs: (readonly string[])[] = [];
    const log = new TailDaemonLog(argv => {
      argvs.push(argv);
      return { exited: Promise.resolve(argvs.length) };
    });
    should(await log.show('/tmp/x.log', true)).equal(1);
    should(await log.show('/tmp/x.log', false)).equal(2);
    should(argvs).eql([
      ['tail', '-F', '-n', '+1', '/tmp/x.log'],
      ['cat', '/tmp/x.log'],
    ]);
  });
});
