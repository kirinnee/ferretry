/**
 * The real machine's process table for `kernel.processes` (`host/adapters/process-table.ts`): today's Codex stopper's
 * `/proc` and `ps` reads, copied, with the daemon's own uid a rule. Linux over a fake `/proc` folder; macOS over a spy
 * that stands in for `ps` and records how it was run.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { hostProcessTable, type PsRun } from '../../../host/adapters/process-table.ts';

const UID = 501;
const HOME = '/home/owner/.ferretry/fleet/homes/codex-a';
const SECRET = 'sk-live-planted-secret-value';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

interface FakeProc {
  readonly pid: number;
  readonly uid?: number;
  readonly argv?: readonly string[];
  readonly environment?: readonly string[];
  readonly parent?: number;
}

async function fakeProc(entries: readonly FakeProc[]) {
  const proc = await realpath(await mkdtemp(`${tmpdir()}/fy-proc-`));
  parents.push(proc);
  const owners = new Map<string, number>();
  for (const entry of entries) {
    const at = `${proc}/${entry.pid}`;
    await mkdir(at);
    owners.set(at, entry.uid ?? UID);
    if (entry.argv !== undefined) await writeFile(`${at}/cmdline`, `${entry.argv.join('\0')}\0`);
    if (entry.environment !== undefined) await writeFile(`${at}/environ`, `${entry.environment.join('\0')}\0`);
    await writeFile(`${at}/stat`, `${entry.pid} (some (odd) name) S ${entry.parent ?? 1} 1 1 0\n`);
  }
  await mkdir(`${proc}/self`);
  await writeFile(`${proc}/meminfo`, 'MemTotal: 1 kB\n');
  return { proc, ownerOf: async (path: string) => owners.get(path) };
}

const linuxTable = async (entries: readonly FakeProc[], kill?: (pid: number, signal: 'SIGTERM') => void) => {
  const { proc, ownerOf } = await fakeProc(entries);
  return hostProcessTable({ platform: 'linux', uid: UID, self: 1000, parent: 999, procRoot: proc, ownerOf, kill });
};

describe('process table: Linux /proc', () => {
  test('a command line is the arguments joined by spaces, for this user’s process only', async () => {
    const table = await linuxTable([
      { pid: 4242, argv: [`${HOME}/packages/app-server-daemon/bin/codex`, 'app-server'] },
      { pid: 4400, uid: 0, argv: [`${HOME}/packages/app-server-daemon/bin/codex`] },
      { pid: 4500, argv: [] },
    ]);
    expect(await table.commandLine(4242)).toBe(`${HOME}/packages/app-server-daemon/bin/codex app-server`);
    expect(await table.commandLine(4400)).toBeUndefined();
    expect(await table.commandLine(4500)).toBeUndefined();
    expect(await table.commandLine(9999)).toBeUndefined();
  });

  test('another uid is never listed, even when its environment matches exactly', async () => {
    const table = await linuxTable([
      { pid: 4242, environment: [`CODEX_HOME=${HOME}`, `OPENAI_API_KEY=${SECRET}`] },
      { pid: 4400, uid: 0, environment: [`CODEX_HOME=${HOME}`] },
      { pid: 4500, environment: [`CODEX_HOME=${HOME}-other`] },
      { pid: 4600, environment: [`NOT_CODEX_HOME=${HOME}`, `CODEX_HOME_X=${HOME}`] },
      { pid: 4700 },
    ]);
    const found = await table.withEnvironment([`CODEX_HOME=${HOME}`]);
    expect(found).toEqual([4242]);
    // environ text never appears in the answer
    expect(JSON.stringify(found)).not.toContain(SECRET);
  });

  test('a table that cannot be listed is undefined', async () => {
    const table = hostProcessTable({
      platform: 'linux',
      uid: UID,
      self: 1,
      parent: 1,
      procRoot: '/nonexistent/fy-proc',
    });
    expect(await table.withEnvironment(['CODEX_HOME=/x'])).toBeUndefined();
  });

  test('the protected pids are 0, 1, the daemon and its whole line of parents', async () => {
    const table = await linuxTable([
      { pid: 999, parent: 700 },
      { pid: 700, parent: 300 },
      { pid: 300, parent: 1 },
    ]);
    expect([...(await table.protectedPids())].sort((a, b) => a - b)).toEqual([0, 1, 300, 700, 999, 1000]);
  });
});

describe('process table: the signal', () => {
  test('only SIGTERM is ever sent (spy); a gone process is gone and a forbidden one refused', async () => {
    const sent: { pid: number; signal: string }[] = [];
    const table = await linuxTable([], (pid, signal) => {
      sent.push({ pid, signal });
      if (pid === 2) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      if (pid === 3) throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    expect(await table.sigterm(4242)).toBe('signalled');
    expect(await table.sigterm(2)).toBe('gone');
    expect(await table.sigterm(3)).toBe('refused');
    expect(sent).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 2, signal: 'SIGTERM' },
      { pid: 3, signal: 'SIGTERM' },
    ]);
  });
});

describe('process table: macOS ps', () => {
  const macTable = (answer: (args: readonly string[]) => PsRun, ps: string | null = '/bin/ps') => {
    const runs: { argv: readonly string[]; environment: Readonly<Record<string, string>> }[] = [];
    const table = hostProcessTable({
      platform: 'darwin',
      uid: UID,
      self: 1000,
      parent: 999,
      locatePs: async () => ps ?? undefined,
      run: async (argv, environment) => {
        runs.push({ argv, environment });
        return answer(argv.slice(1));
      },
    });
    return { table, runs };
  };

  test('a value holding whitespace cannot be matched from ps -E output: the answer is "cannot tell", never "nobody"', async () => {
    const { table, runs } = macTable(() => ({ code: 0, stdout: `4242 ${UID} codex CODEX_HOME=/Users/a/My Home/x\n` }));
    expect(await table.withEnvironment(['CODEX_HOME=/Users/a/My Home/x'])).toBeUndefined();
    expect(runs).toEqual([]);
  });

  test('ps is called with an empty env and an absolute path, and a relative ps is never run', async () => {
    const { table, runs } = macTable(() => ({ code: 0, stdout: `${UID} /usr/bin/true\n` }));
    expect(await table.commandLine(4242)).toBe('/usr/bin/true');
    expect(await table.withEnvironment(['CODEX_HOME=/x'])).toEqual([]);
    expect(runs.length).toBe(2);
    for (const run of runs) {
      expect(run.argv[0]).toBe('/bin/ps');
      expect(run.environment).toEqual({});
    }
    const relative = macTable(() => ({ code: 0, stdout: '' }), 'ps');
    expect(await relative.table.commandLine(4242)).toBeUndefined();
    expect(await relative.table.withEnvironment(['CODEX_HOME=/x'])).toBeUndefined();
    expect(relative.runs).toEqual([]);
    const missing = macTable(() => ({ code: 0, stdout: '' }), null);
    expect(await missing.table.withEnvironment(['CODEX_HOME=/x'])).toBeUndefined();
  });

  test('another uid is never listed or read, and a failed ps is unknown', async () => {
    const { table } = macTable(args =>
      args[0] === '-wwEx'
        ? {
            code: 0,
            stdout: [
              ` 4242 ${UID} ${HOME}/packages/app-server-daemon/bin/codex CODEX_HOME=${HOME} OPENAI_API_KEY=${SECRET}`,
              ` 4400 0 /bin/codex CODEX_HOME=${HOME}`,
              ` 4500 ${UID} /bin/codex CODEX_HOME=${HOME}-other`,
              'garbage',
            ].join('\n'),
          }
        : { code: 0, stdout: `0 ${HOME}/packages/app-server-daemon/bin/codex\n` },
    );
    expect(await table.withEnvironment([`CODEX_HOME=${HOME}`])).toEqual([4242]);
    expect(await table.commandLine(4400)).toBeUndefined();
    const failing = macTable(() => ({ code: 1, stdout: '' }));
    expect(await failing.table.withEnvironment([`CODEX_HOME=${HOME}`])).toBeUndefined();
    expect(await failing.table.commandLine(4242)).toBeUndefined();
  });

  test('the daemon’s line of parents is walked through ps', async () => {
    const parents: Record<string, string> = { '999': '700', '700': '1' };
    const { table } = macTable(args => ({ code: 0, stdout: `${parents[args[3] as string] ?? ''}\n` }));
    expect([...(await table.protectedPids())].sort((a, b) => a - b)).toEqual([0, 1, 700, 999, 1000]);
  });
});
