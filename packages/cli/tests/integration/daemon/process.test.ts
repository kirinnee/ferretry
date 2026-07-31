import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
});
