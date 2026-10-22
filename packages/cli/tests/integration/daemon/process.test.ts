import { afterEach, beforeEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process';

/**
 * Real processes, but only ones this test started, and only inside a temp directory.
 *
 * Nothing here reads a pid from any state home, and nothing signals a process this test did not
 * spawn. The throwaway child is a `sleep`, so a leaked one is harmless and is killed in teardown.
 */
describe('bun daemon process', () => {
  const subject = new BunDaemonProcess();
  let root = '';
  const spawned: number[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy-process-'));
  });

  afterEach(async () => {
    for (const pid of spawned.splice(0)) subject.signal(pid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  it('should capture stdout, stderr and the exit code of a command that succeeds', async () => {
    // Act
    const actual = await subject.run(['sh', '-c', 'printf out; printf err >&2']);

    // Assert
    should(actual.code).equal(0);
    should(actual.stdout).equal('out');
    should(actual.stderr).equal('err');
  });

  it('should report a non-zero exit code without throwing', async () => {
    // Act — a service-manager verb that fails is information the supervisor interprets, not a crash.
    const actual = await subject.run(['sh', '-c', 'echo nope >&2; exit 3']);

    // Assert
    should(actual.code).equal(3);
    should(actual.stderr).equal('nope\n');
  });

  it('should report a missing service manager as an outcome rather than an exception', async () => {
    // Act
    const actual = await subject.run([join(root, 'no-such-systemctl')]);

    // Assert
    should(actual.code).equal(127);
    should(actual.stderr).not.be.empty();
  });

  it('should refuse an empty command', async () => {
    // Act + Assert
    await should(subject.run([])).be.rejectedWith(/cannot run an empty command/u);
  });

  it('should launch a detached child, append its output to the log, and report its pid', async () => {
    // Arrange
    const logFile = join(root, 'fyd.log');

    // Act
    const handle = await subject.spawnDetached({
      argv: ['sh', '-c', 'echo started; echo warned >&2; sleep 30'],
      environment: { FY_HOME: root, PATH: process.env.PATH ?? '' },
      logFile,
    });

    // Assert
    should(handle.pid).be.a.Number();
    if (handle.pid !== undefined) spawned.push(handle.pid);
    await Bun.sleep(150);
    const written = await Bun.file(logFile).text();
    should(written).containEql('started');
    should(written).containEql('warned');
  });

  it('should start the daemon in its own session, so closing the terminal cannot hang it up', async () => {
    // Arrange
    const logFile = join(root, 'session.log');

    // Act
    const handle = await subject.spawnDetached({
      argv: ['sh', '-c', 'sleep 30'],
      environment: { PATH: process.env.PATH ?? '' },
      logFile,
    });
    if (handle.pid === undefined) throw new Error('no pid');
    spawned.push(handle.pid);

    // Assert — a session leader leads its own process group; a child left in this one would share ours,
    // and with it the terminal's SIGHUP.
    const groupOf = async (pid: number): Promise<string> =>
      (await subject.run(['ps', '-o', 'pgid=', '-p', String(pid)])).stdout.trim();
    should(await groupOf(handle.pid)).equal(String(handle.pid));
    should(await groupOf(handle.pid)).not.equal(await groupOf(process.pid));
  });

  it('should append to an existing log rather than truncate the daemon history', async () => {
    // Arrange
    const logFile = join(root, 'fyd.log');
    await Bun.write(logFile, 'earlier run\n');

    // Act
    const handle = await subject.spawnDetached({
      argv: ['sh', '-c', 'echo later'],
      environment: { PATH: process.env.PATH ?? '' },
      logFile,
    });
    if (handle.pid !== undefined) spawned.push(handle.pid);
    await Bun.sleep(150);

    // Assert
    should(await Bun.file(logFile).text()).equal('earlier run\nlater\n');
  });

  it('should pass only the environment it was given to the daemon', async () => {
    // Arrange
    const logFile = join(root, 'env.log');

    // Act
    const handle = await subject.spawnDetached({
      argv: ['sh', '-c', 'echo "home=${FY_HOME:-unset} extra=${FY_UNEXPECTED:-unset}"'],
      environment: { FY_HOME: root, PATH: process.env.PATH ?? '' },
      logFile,
    });
    if (handle.pid !== undefined) spawned.push(handle.pid);
    await Bun.sleep(150);

    // Assert
    should(await Bun.file(logFile).text()).equal(`home=${root} extra=unset\n`);
  });

  it('should refuse an empty launch', async () => {
    // Act + Assert
    await should(subject.spawnDetached({ argv: [], environment: {}, logFile: join(root, 'fyd.log') })).be.rejectedWith(
      /cannot launch an empty command/u,
    );
  });

  it('should see its own child alive and then gone after it signals it', async () => {
    // Arrange
    const handle = await subject.spawnDetached({
      argv: ['sleep', '30'],
      environment: { PATH: process.env.PATH ?? '' },
      logFile: join(root, 'fyd.log'),
    });
    const pid = handle.pid ?? 0;
    spawned.push(pid);

    // Act + Assert
    should(subject.alive(pid)).be.true();
    should(subject.signal(pid, 'SIGTERM')).be.true();
    for (let attempt = 0; attempt < 50 && subject.alive(pid); attempt += 1) await Bun.sleep(20);
    should(subject.alive(pid)).be.false();
  });

  it('should escalate to an unconditional kill', async () => {
    // Arrange — a shell that ignores SIGTERM is exactly the case escalation exists for.
    const handle = await subject.spawnDetached({
      argv: ['sh', '-c', 'trap "" TERM; sleep 30'],
      environment: { PATH: process.env.PATH ?? '' },
      logFile: join(root, 'fyd.log'),
    });
    const pid = handle.pid ?? 0;
    spawned.push(pid);
    await Bun.sleep(150);

    // Act
    subject.signal(pid, 'SIGTERM');
    await Bun.sleep(150);
    const survived = subject.alive(pid);
    subject.signal(pid, 'SIGKILL');
    for (let attempt = 0; attempt < 50 && subject.alive(pid); attempt += 1) await Bun.sleep(20);

    // Assert
    should(survived).be.true();
    should(subject.alive(pid)).be.false();
  });

  it('should report a pid it cannot signal as gone rather than throwing', async () => {
    // Act + Assert — an unsignallable pid is a fact the caller reports, not an exception.
    should(subject.signal(0x7ffffff0, 'SIGTERM')).be.false();
    should(subject.alive(0x7ffffff0)).be.false();
  });

  it('should prove which process holds a file open, on this host, for this test and for a child it started', async () => {
    // Arrange — the identity a lifecycle verb asks for before it signals: Linux answers from /proc and
    // macOS from lsof, and the default adapter must pick whichever this host has.
    const held = join(root, 'daemon.lock');
    const other = join(root, 'other.lock');
    await writeFile(held, '');
    await writeFile(other, '');
    const handle = await open(held, 'r');
    const child = await subject.spawnDetached({
      argv: ['sh', '-c', `exec 3<"${other}"; sleep 30`],
      environment: { PATH: process.env.PATH ?? '' },
      logFile: join(root, 'child.log'),
    });
    const childPid = child.pid ?? 0;
    spawned.push(childPid);
    await Bun.sleep(150);

    try {
      // Act
      const answers = [
        await subject.holdsOpen(process.pid, held),
        await subject.holdsOpen(childPid, other),
        await subject.holdsOpen(childPid, held),
        await subject.holdsOpen(process.pid, join(root, 'never-created.lock')),
      ];

      // Assert
      should(answers).deepEqual([true, true, false, false]);
    } finally {
      await handle.close();
    }
  });

  it('should read /proc descriptors and refuse to guess about a process it may not inspect', async () => {
    // Arrange — a stand-in /proc, so the refusal does not depend on some other user's process.
    const proc = join(root, 'proc');
    const target = join(root, 'daemon.lock');
    await writeFile(target, '');
    await mkdir(join(proc, 'self', 'fd'), { recursive: true });
    await mkdir(join(proc, '789', 'fd'), { recursive: true });
    await writeFile(join(proc, '789', 'fd', '0'), 'not a descriptor link');
    await symlink(target, join(proc, '789', 'fd', '3'));
    await mkdir(join(proc, '790', 'fd'), { recursive: true });
    await mkdir(join(proc, '123'), { recursive: true });
    await writeFile(join(proc, '123', 'fd'), 'unreadable as a directory');
    const faked = new BunDaemonProcess({ procDirectory: proc });

    // Act
    const answers = [
      await faked.holdsOpen(789, target),
      await faked.holdsOpen(790, target),
      await faked.holdsOpen(456, target),
      await faked.holdsOpen(123, target),
    ];

    // Assert — holds it, holds nothing, gone, and cannot be looked inside.
    should(answers).deepEqual([true, false, false, undefined]);
  });

  it('should ask lsof where there is no /proc, and say it cannot tell when there is no lsof', async () => {
    // Arrange — macOS's path, exercised here with stand-ins for the command.
    const noProc = join(root, 'no-proc');
    const target = join(root, 'daemon.lock');
    const lsof = join(root, 'lsof');
    await writeFile(lsof, '#!/bin/sh\necho 42\n');
    await chmod(lsof, 0o755);
    const answer = (command: string, pid: number): Promise<boolean | undefined> =>
      new BunDaemonProcess({ procDirectory: noProc, lsof: command }).holdsOpen(pid, target);

    // Act
    const answers = [
      await answer(lsof, 42),
      await answer(lsof, 43),
      await answer('false', 42),
      await answer(join(root, 'missing-lsof'), 42),
    ];

    // Assert
    should(answers).deepEqual([true, false, false, undefined]);
  });
});

describe('BunDaemonProcess.runStreaming', () => {
  it('hands over each line as it is written, ending a line at \\n or \\r, and still returns everything', async () => {
    const lines: string[] = [];
    const outcome = await new BunDaemonProcess().runStreaming(
      ['sh', '-c', "printf 'one\\ntwo\\r33%%\\r66%%\\n'; printf 'err\\n' >&2; printf 'tail'; exit 3"],
      line => lines.push(line),
    );
    should(outcome.code).equal(3);
    should(outcome.stdout).equal('one\ntwo\r33%\r66%\ntail');
    should(outcome.stderr).equal('err\n');
    should([...lines].sort()).deepEqual(['33%', '66%', 'err', 'one', 'tail', 'two'].sort());
  });

  it('works with nobody listening, and says 127 for a missing command', async () => {
    const processes = new BunDaemonProcess();
    should((await processes.runStreaming(['sh', '-c', 'echo hi'])).stdout).equal('hi\n');
    should((await processes.runStreaming(['definitely-not-a-command-xyz'])).code).equal(127);
    await processes.runStreaming([]).then(
      () => should.fail(undefined, undefined, 'expected a throw'),
      error => should((error as Error).message).containEql('empty command'),
    );
  });
});
