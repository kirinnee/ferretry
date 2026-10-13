/**
 * The host side of stopping a Codex runtime's app-server daemon, against a fake process table: a
 * `/proc`-shaped directory on Linux, and a stand-in `ps` for a platform without one. Nothing here
 * signals a real process — `terminate` is handed a recorder.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { HostCodexAppServerProcesses } from '../../../src/adapters/process/codex-app-server-stopper.ts';

const HOME = '/state/fleet/homes/runtime-one';
let root = '';
let proc = '';
let ps = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-codex-daemon-'));
  proc = join(root, 'proc');
  const entry = async (pid: string, cmdline: string, environ: string | undefined) => {
    await mkdir(join(proc, pid), { recursive: true });
    await writeFile(join(proc, pid, 'cmdline'), cmdline);
    if (environ !== undefined) await writeFile(join(proc, pid, 'environ'), environ);
  };
  await entry(
    '100',
    `${HOME}/packages/app-server-daemon/bin/codex\0app-server\0--managed-daemon\0`,
    `PATH=/bin\0CODEX_HOME=${HOME}\0`,
  );
  await entry('200', '/usr/bin/codex\0', `CODEX_HOME=${HOME}-other\0`);
  await entry('300', '', undefined);
  await mkdir(join(proc, 'self'), { recursive: true });
  await writeFile(join(root, 'daemon.pid'), '{"pid":100}');
  ps = join(root, 'ps');
  await writeFile(
    ps,
    [
      '#!/bin/sh',
      'case "$*" in',
      `  "-wwEx -o pid=,command=") printf '  100 /x/codex app-server CODEX_HOME=${HOME} TERM=x\\n  200 /usr/bin/codex CODEX_HOME=${HOME}-other\\nnoise\\n' ;;`,
      `  "-ww -o command= -p 100") printf '/x/codex app-server\\n' ;;`,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  await chmod(ps, 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('HostCodexAppServerProcesses on Linux', () => {
  const subject = () => new HostCodexAppServerProcesses({ platform: 'linux', procRoot: proc });

  it('should read a pid file, and nothing for one that is not there', async () => {
    should(await subject().read(join(root, 'daemon.pid'))).equal('{"pid":100}');
    should(await subject().read(join(root, 'missing.pid'))).be.undefined();
  });

  it('should read a command line from the process table', async () => {
    should(await subject().commandLine(100)).equal(
      `${HOME}/packages/app-server-daemon/bin/codex app-server --managed-daemon`,
    );
    should(await subject().commandLine(300)).be.undefined();
    should(await subject().commandLine(999)).be.undefined();
  });

  it('should list exactly the processes whose CODEX_HOME is that home', async () => {
    should(await subject().usersOf(HOME)).deepEqual([100]);
  });

  it('should say it cannot tell when there is no process table', async () => {
    const none = new HostCodexAppServerProcesses({ platform: 'linux', procRoot: join(root, 'absent') });
    should(await none.usersOf(HOME)).be.undefined();
  });

  it('should signal through the given seam and swallow a process that is already gone', async () => {
    // Arrange
    const signalled: number[] = [];
    const recording = new HostCodexAppServerProcesses({ platform: 'linux', signal: pid => signalled.push(pid) });
    const gone = new HostCodexAppServerProcesses({
      platform: 'linux',
      signal: () => {
        throw new Error('ESRCH');
      },
    });

    // Act
    await recording.terminate(100);
    await gone.terminate(100);

    // Assert
    should(signalled).deepEqual([100]);
  });
});

describe('HostCodexAppServerProcesses without /proc', () => {
  it('should ask ps for a command line and for the users of a home', async () => {
    // Arrange
    const subject = new HostCodexAppServerProcesses({ platform: 'darwin', psExecutable: ps });

    // Act + Assert
    should(await subject.commandLine(100)).equal('/x/codex app-server');
    should(await subject.commandLine(101)).be.undefined();
    should(await subject.usersOf(HOME)).deepEqual([100]);
  });

  it('should say it cannot tell when ps is missing, relative or fails to run', async () => {
    for (const psExecutable of [undefined, 'ps', join(root, 'no-such-ps')]) {
      const subject = new HostCodexAppServerProcesses({
        platform: 'darwin',
        ...(psExecutable === undefined ? {} : { psExecutable }),
      });
      should(await subject.usersOf(HOME)).be.undefined();
      should(await subject.commandLine(100)).be.undefined();
    }
  });
});
