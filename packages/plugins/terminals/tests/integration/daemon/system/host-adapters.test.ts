import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import { constants, lstat, open } from '../../../../daemon/adapters/host/fs.ts';
import {
  HarnessProcessProvenance,
  ProjectMcpServers,
  RegularOutputFile,
  SigtermProcessSignal,
} from '../../../../daemon/adapters/session/processes/output-file.ts';
import { processIncarnationFor } from '../../../../daemon/adapters/session/processes/process-incarnation.ts';
import { ExecutableCodePrograms } from '../../../../daemon/adapters/system/executable-code-programs.ts';

const folders: string[] = [];
const fresh = async (): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), 'fy-terminals-adapters-'));
  folders.push(folder);
  return folder;
};
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('the output file of a process, read as a regular file and nothing else', () => {
  test('the newest bytes are read, from an offset when one is given, and a relative or missing path is refused or gone', async () => {
    const folder = await fresh();
    const file = join(folder, 'out.log');
    await writeFile(file, '0123456789');
    const output = new RegularOutputFile();

    const tail = await output.read(file, undefined, 4);
    const from = await output.read(file, 3, 100);

    expect(tail.kind === 'read' && [text(tail.bytes), tail.start, tail.size]).toEqual(['6789', 6, 10]);
    expect(from.kind === 'read' && text(from.bytes)).toBe('3456789');
    expect(await output.read('relative/out.log', undefined, 4)).toEqual({
      kind: 'refused',
      reason: 'Its output path is not absolute.',
    });
    expect(await output.read(join(folder, 'absent.log'), undefined, 4)).toEqual({ kind: 'gone' });
  });

  test('a folder or a link is refused, never read through', async () => {
    const folder = await fresh();
    await writeFile(join(folder, 'real.log'), 'secret');
    await symlink(join(folder, 'real.log'), join(folder, 'link.log'));
    const output = new RegularOutputFile();

    expect(await output.read(folder, undefined, 4)).toEqual({
      kind: 'refused',
      reason: 'Its output is not a regular file.',
    });
    expect(await output.read(join(folder, 'link.log'), undefined, 4)).toEqual({
      kind: 'refused',
      reason: 'Its output is not a regular file.',
    });
  });

  test('a file that cannot be opened is gone, and one swapped between the check and the open is refused', async () => {
    const folder = await fresh();
    const file = join(folder, 'out.log');
    await writeFile(file, 'abc');
    const cannotOpen = new RegularOutputFile({ lstat, open: async () => Promise.reject(new Error('EACCES')) });
    const swapped = new RegularOutputFile({
      lstat: async path => Object.create(await lstat(path), { ino: { value: 1 } }) as never,
      open,
    });

    expect(await cannotOpen.read(file, undefined, 10)).toEqual({ kind: 'gone' });
    expect(await swapped.read(file, undefined, 10)).toEqual({
      kind: 'refused',
      reason: 'Its output file changed while it was being opened.',
    });
  });

  test('a file that shrank while it was read gives what was there instead of hanging', async () => {
    const folder = await fresh();
    const file = join(folder, 'out.log');
    await writeFile(file, '0123456789');
    const shrinking = new RegularOutputFile({
      lstat,
      open: async (path, flags) => {
        const handle = await open(path, flags);
        await truncate(path, 4);
        const realStat = handle.stat.bind(handle);
        return Object.assign(handle, {
          stat: async () => Object.create(await realStat(), { size: { value: 10 } }),
        }) as never;
      },
    });

    const read = await shrinking.read(file, undefined, 10);

    expect(read.kind === 'read' && text(read.bytes)).toBe('0123');
    expect(constants.O_RDONLY).toBeDefined();
  });
});

describe('ending a process', () => {
  test('SIGTERM ends a running process, and a process that is already gone answers false', async () => {
    const child = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    const signal = new SigtermProcessSignal();

    expect(await signal.terminate(child.pid)).toBe(true);
    await child.exited;

    expect(await signal.terminate(child.pid)).toBe(false);
  });

  test('a failure that is not "already gone" is passed on', async () => {
    await expect(new SigtermProcessSignal().terminate(Number.NaN)).rejects.toThrow();
  });
});

describe('which processes are the harness’s own', () => {
  test('the servers a project names are read from its .mcp.json, and a missing or broken file names none', async () => {
    const project = await fresh();
    await writeFile(
      join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { tools: { command: 'fy', args: ['mcp', 'serve'] } } }),
    );
    const broken = await fresh();
    await writeFile(join(broken, '.mcp.json'), '{ not json');
    const servers = new ProjectMcpServers();

    expect(await servers.read(project)).toEqual([{ name: 'tools', command: 'fy', args: ['mcp', 'serve'] }]);
    expect(await servers.read(broken)).toEqual([]);
    expect(await servers.read(join(project, 'absent'))).toEqual([]);
  });

  test('a configured server is recognised under the pane found through the procfs, and nothing is read without a procfs', async () => {
    const project = await fresh();
    await writeFile(
      join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { weather: { command: 'weather-server', args: [] } } }),
    );
    const proc = await fresh();
    await mkdir(join(proc, '4242'));
    await symlink(project, join(proc, '4242', 'cwd'));
    const rows = [{ pid: 9_001, ppid: 4_242, start: 1, startedAtMs: 0, argv: 'weather-server', state: 'S' }];

    const withProc = await new HarnessProcessProvenance('fy', new ProjectMcpServers(), proc).identify(rows, 4_242);
    const withoutProc = await new HarnessProcessProvenance('fy', new ProjectMcpServers(), null).identify(rows, 4_242);
    const unknownPane = await new HarnessProcessProvenance('fy', new ProjectMcpServers(), proc).identify(rows, 777);

    expect(withProc.has(9_001)).toBe(true);
    expect(withoutProc.has(9_001)).toBe(false);
    expect(unknownPane.has(9_001)).toBe(false);
  });
});

describe('telling one process from a later one with the same pid', () => {
  const spawnOf = (result: SpawnResult | 'throw'): SpawnPort =>
    ({
      run: async () => {
        if (result === 'throw') throw new Error('no ps');
        return result;
      },
    }) as unknown as SpawnPort;
  const done = (stdout: string, exitCode = 0): SpawnResult => ({ exitCode, signal: null, stdout, stderr: '' });

  test('on Linux the start time is the kernel’s, exact for this process and nothing for a pid that does not exist', async () => {
    const incarnation = processIncarnationFor('linux');

    expect(await incarnation.startOf(process.pid)).toBeGreaterThan(0);
    expect(await incarnation.startOf(2 ** 30)).toBeUndefined();
  });

  test('on macOS the start time is what ps says to the second, and a failed or odd answer, or a bad pid, is nothing', async () => {
    const at = 'Sat Nov  7 09:00:00 2026\n';

    expect(await processIncarnationFor('darwin', spawnOf(done(at))).startOf(10)).toBe(
      Date.UTC(2026, 10, 7, 9, 0, 0) / 1000,
    );
    expect(await processIncarnationFor('darwin', spawnOf(done(at, 1))).startOf(10)).toBeUndefined();
    expect(await processIncarnationFor('darwin', spawnOf(done('not a date'))).startOf(10)).toBeUndefined();
    expect(await processIncarnationFor('darwin', spawnOf('throw')).startOf(10)).toBeUndefined();
    expect(await processIncarnationFor('darwin', spawnOf(done(at))).startOf(0)).toBeUndefined();
    expect(await processIncarnationFor('darwin', spawnOf(done(at))).startOf(1.5)).toBeUndefined();
  });

  test('anywhere else, and on macOS with no spawn to ask ps, a session refuses to start and says why', async () => {
    await expect(processIncarnationFor('win32').startOf(10)).rejects.toThrow('sessions cannot start on win32');
    await expect(processIncarnationFor('darwin').startOf(10)).rejects.toThrow('sessions cannot start on darwin');
    expect(processIncarnationFor()).toBeDefined();
  });
});

describe('whether a process runs a code program from a folder this account cannot replace', () => {
  const programs = (opts: {
    exe?: string | undefined | 'throw';
    resolves?: Record<string, string | undefined | 'throw'>;
    replaceable?: boolean | 'throw';
  }) =>
    new ExecutableCodePrograms(
      async () => {
        if (opts.exe === 'throw') throw new Error('gone');
        return opts.exe;
      },
      async path => {
        const answer = opts.resolves?.[path];
        if (answer === 'throw') throw new Error('io');
        return answer;
      },
      async () => {
        if (opts.replaceable === 'throw') throw new Error('io');
        return opts.replaceable ?? false;
      },
      ['/usr/bin', '/bin'],
    );
  const ssh = { '/usr/bin/ssh': '/usr/bin/ssh', '/bin/ssh': '/usr/bin/ssh' };

  test('a program in a root folder that this account cannot replace is proved, by a set of names or a test for them', async () => {
    const world = programs({ exe: '/usr/bin/ssh', resolves: ssh });

    expect(await world.codeProgram(10)).toBe(true);
    expect(await world.provenRootProgram(10, new Set(['ssh']))).toBe('ssh');
    expect(await world.provenRootProgram(10, name => name.startsWith('ss'))).toBe('ssh');
    expect(await world.provenRootProgram(10, new Set(['scp']))).toBeUndefined();
  });

  test('anything unproven or unreadable is no program: a bad pid, no executable, a relative or deleted path, an unresolvable file', async () => {
    const names = new Set(['ssh']);

    expect(await programs({ exe: '/usr/bin/ssh', resolves: ssh }).provenRootProgram(0, names)).toBeUndefined();
    expect(await programs({ exe: '/usr/bin/ssh', resolves: ssh }).provenRootProgram(1.5, names)).toBeUndefined();
    expect(await programs({ exe: undefined }).provenRootProgram(10, names)).toBeUndefined();
    expect(await programs({ exe: 'throw' }).provenRootProgram(10, names)).toBeUndefined();
    expect(await programs({ exe: 'ssh', resolves: ssh }).provenRootProgram(10, names)).toBeUndefined();
    expect(
      await programs({ exe: '/usr/bin/ssh (deleted)', resolves: ssh }).provenRootProgram(10, names),
    ).toBeUndefined();
    expect(await programs({ exe: '/usr/bin/ssh', resolves: {} }).provenRootProgram(10, names)).toBeUndefined();
    expect(
      await programs({ exe: '/usr/bin/ssh', resolves: { '/usr/bin/ssh': 'throw' } }).provenRootProgram(10, names),
    ).toBeUndefined();
  });

  test('a copy of the program elsewhere, a folder entry that is another file or one this account could replace is not proof', async () => {
    const names = new Set(['ssh']);
    const home = '/home/user/bin/ssh';

    expect(
      await programs({ exe: home, resolves: { [home]: home, '/usr/bin/ssh': '/usr/bin/ssh' } }).provenRootProgram(
        10,
        names,
      ),
    ).toBeUndefined();
    expect(
      await programs({ exe: '/usr/bin/ssh', resolves: ssh, replaceable: true }).provenRootProgram(10, names),
    ).toBeUndefined();
    expect(
      await programs({ exe: '/usr/bin/ssh', resolves: ssh, replaceable: 'throw' }).provenRootProgram(10, names),
    ).toBeUndefined();
    expect(
      await programs({
        exe: '/usr/bin/ssh',
        resolves: { '/usr/bin/ssh': 'throw', '/bin/ssh': undefined },
      }).provenRootProgram(10, names),
    ).toBeUndefined();
    const second = programs({
      exe: '/usr/bin/ssh',
      resolves: { '/usr/bin/ssh': '/usr/bin/ssh', '/bin/ssh': '/usr/bin/ssh' },
    });
    expect(await second.codeProgram(10)).toBe(true);
  });

  test('on Linux the executable is read from the kernel for this very process, and elsewhere nothing is proved', async () => {
    const linux = ExecutableCodePrograms.forPlatform('linux', process.getuid?.());

    expect(await linux.provenRootProgram(process.pid, () => false)).toBeUndefined();
    expect(await linux.codeProgram(process.pid)).toBe(false);
    expect(await linux.provenRootProgram(2 ** 30, () => true)).toBeUndefined();
    expect(
      await ExecutableCodePrograms.forPlatform('darwin', 501).provenRootProgram(process.pid, () => true),
    ).toBeUndefined();
    expect(await ExecutableCodePrograms.forPlatform('linux', undefined).codeProgram(process.pid)).toBe(false);
  });

  test.skipIf(process.platform !== 'linux' || process.getuid?.() === 0 || !existsSync('/usr/bin/tail'))(
    'a real program from a root folder is proved by its kernel-kept executable, not by its name',
    async () => {
      const child = Bun.spawn(['/usr/bin/tail', '-f', '/dev/null'], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      try {
        const linux = ExecutableCodePrograms.forPlatform('linux', process.getuid?.());

        expect(await linux.provenRootProgram(child.pid, new Set(['tail']))).toBe('tail');
        expect(await linux.provenRootProgram(child.pid, new Set(['ssh']))).toBeUndefined();
      } finally {
        child.kill();
      }
    },
  );
});
