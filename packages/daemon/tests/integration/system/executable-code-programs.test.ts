import { afterEach, describe, it } from 'bun:test';
import { copyFile, mkdtemp, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import should from 'should';
import { ExecutableCodePrograms } from '../../../src/adapters/system/executable-code-programs.ts';

/**
 * THE CODE-PROGRAM PROOF AGAINST REAL PROCESSES: `/proc/<pid>/exe` as the kernel keeps it, the files on this disk and
 * this account. A process proves a program only when the file it runs is what a root folder resolves the name to,
 * through an entry this account cannot change (docs/input-requests.md, "One-time codes").
 */

const linux = process.platform === 'linux';
const programs = ExecutableCodePrograms.forPlatform('linux');
const children: Bun.Subprocess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(directories.splice(0).map(async folder => await rm(folder, { recursive: true, force: true })));
});

/** Starts `argv` and waits until the kernel shows it running its own executable. */
async function started(argv: readonly string[]): Promise<number> {
  const child = Bun.spawn([...argv], { stdout: 'ignore', stderr: 'ignore' });
  children.push(child);
  for (let tries = 0; tries < 100; tries += 1) {
    const comm = await readFile(`/proc/${String(child.pid)}/comm`, 'utf8').catch(() => '');
    if (comm !== '' && comm.trim() !== basename(process.execPath)) return child.pid;
    await Bun.sleep(10);
  }
  return child.pid;
}

/** A copy of `sleep`, under `name`, in a folder this account owns. */
async function copied(name: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'fy-code-program-'));
  directories.push(folder);
  const sleep = await realpath(Bun.which('sleep') ?? '/bin/sleep');
  const copy = join(folder, name);
  await copyFile(sleep, copy);
  return copy;
}

/** The first `sleep` in a root folder, to run as a program the proof can stand on. */
const ROOT_SLEEP = ['/usr/bin/sleep', '/bin/sleep', '/run/current-system/sw/bin/sleep'].find(
  path => Bun.file(path).size > 0,
);

describe('ExecutableCodePrograms on real processes', () => {
  it.skipIf(!linux || ROOT_SLEEP === undefined)(
    'should prove a program a root folder holds, by the name of the file it runs, and only among the names asked',
    async () => {
      // Arrange
      const entry = ROOT_SLEEP as string;
      const pid = await started([entry, '30']);
      const name = basename(await realpath(entry));

      // Act / Assert — sleep is no code program, but it is a proven root program by its own name.
      should(await programs.provenRootProgram(pid, () => true)).equal(name);
      should(await programs.codeProgram(pid)).be.false();
    },
  );

  it.skipIf(!linux)('should not prove a copy named ssh in a folder this account owns', async () => {
    // Arrange — `cp /bin/sleep ~/bin/ssh`: the right name, nobody's ssh.
    const pid = await started([await copied('ssh'), '30']);

    // Act / Assert
    should(await programs.codeProgram(pid)).be.false();
    should(await programs.provenRootProgram(pid, () => true)).be.undefined();
  });

  it.skipIf(!linux)('should not prove a shell that renamed itself ssh: the kernel still knows its file', async () => {
    // Arrange — `printf ssh > /proc/$$/comm`: what ps shows changes, /proc/<pid>/exe does not.
    const child = Bun.spawn(['bash', '-c', 'printf ssh > /proc/$$/comm; sleep 30; :'], { stdout: 'ignore' });
    children.push(child);
    for (let tries = 0; tries < 100; tries += 1) {
      if ((await readFile(`/proc/${String(child.pid)}/comm`, 'utf8').catch(() => '')).trim() === 'ssh') break;
      await Bun.sleep(10);
    }

    // Act / Assert
    should((await readFile(`/proc/${String(child.pid)}/comm`, 'utf8')).trim()).equal('ssh');
    should(await programs.codeProgram(child.pid)).be.false();
  });

  it.skipIf(!linux)('should not prove a program whose file was deleted while it runs', async () => {
    // Arrange
    const copy = await copied('ssh');
    const pid = await started([copy, '30']);
    await unlink(copy);

    // Act / Assert — the kernel reads "<path> (deleted)".
    should(await programs.provenRootProgram(pid, () => true)).be.undefined();
  });

  it('should prove nothing for a process that is not there, a bad pid, or off Linux', async () => {
    // Act / Assert
    should(await programs.codeProgram(2 ** 22 + 7)).be.false();
    should(await programs.codeProgram(0)).be.false();
    should(await ExecutableCodePrograms.forPlatform('darwin').codeProgram(process.pid)).be.false();
  });

  it('should fail closed when the file cannot be resolved or its folder cannot be looked at', async () => {
    // Arrange — the two failures no real process gives on demand.
    const unresolved = new ExecutableCodePrograms(
      async () => '/usr/bin/ssh',
      async () => undefined,
      async () => false,
    );
    const unreadable = new ExecutableCodePrograms(
      async () => '/usr/bin/ssh',
      async path => path,
      async () => {
        throw new Error('lstat failed');
      },
    );

    // Act / Assert
    should(await unresolved.codeProgram(4242)).be.false();
    should(await unreadable.codeProgram(4242)).be.false();
  });
});
