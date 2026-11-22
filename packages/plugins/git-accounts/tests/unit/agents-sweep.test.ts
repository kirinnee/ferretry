import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildHandle, Clock, SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import { bunSpawn } from '@ferretry/kernel/host';
import type { GitAccountId } from '../../contract/index.ts';
import { psAgentProcesses, parsePsListing } from '../../daemon/adapters/agent-processes.ts';
import { AgentSupervisor } from '../../daemon/features/ssh-keys/agents.ts';
import {
  type AgentProcess,
  type AgentProcessTable,
  ownAgentAccount,
  sweepLeftoverAgents,
} from '../../daemon/features/ssh-keys/sweep.ts';
import { bareNames, tmpRunFolder } from './run-folder.ts';

const FOLDER = '/fy/state/git-accounts/downloads';
const ME = 1000;
const SELF = 4000;
const quiet = { warn: () => undefined };
const instant: Pick<Clock, 'sleep'> = { sleep: async () => undefined };
const agent = (pid: number, args: string, uid = ME): AgentProcess => ({ pid, uid, args });
const OWN = `ssh-agent -D -a ${FOLDER}/gha_77.sock`;

/** A process table over a made-up machine: `terminate` ends a process only when `signalable` says so. */
function machine(initial: readonly AgentProcess[], signalable: (pid: number) => boolean = () => true) {
  let live = [...initial];
  const signalled: number[] = [];
  const table: AgentProcessTable = {
    list: async () => live,
    read: async pid => live.find(entry => entry.pid === pid),
    terminate: pid => {
      signalled.push(pid);
      if (!signalable(pid)) return false;
      live = live.filter(entry => entry.pid !== pid);
      return true;
    },
  };
  return { table, signalled, alive: () => live.map(entry => entry.pid) };
}

describe('which processes are this daemon’s own agents', () => {
  test.each([
    [OWN, 'gha_77'],
    [`/usr/bin/ssh-agent -D -a ${FOLDER}/gha_12345678901234567890.sock`, 'gha_12345678901234567890'],
  ])('%j is account %j', (args, account) => expect(ownAgentAccount(args, FOLDER)).toBe(account as GitAccountId));

  test.each([
    ['the person’s own login agent (a temp folder of its own)', 'ssh-agent -l -a /tmp/ssh-AbCd/agent.1'],
    ['an agent of another folder (another install)', 'ssh-agent -D -a /other/state/git-accounts/downloads/gha_77.sock'],
    ['an agent in a folder that only starts with ours', `ssh-agent -D -a ${FOLDER}-b/gha_77.sock`],
    ['another prefix in our folder', `ssh-agent -D -a ${FOLDER}/other_77.sock`],
    ['a name that is not an account id', `ssh-agent -D -a ${FOLDER}/gha_x.sock`],
    ['a path that climbs out', `ssh-agent -D -a ${FOLDER}/../gha_77.sock`],
    ['a path below a subfolder', `ssh-agent -D -a ${FOLDER}/sub/gha_77.sock`],
    ['another flag set', `ssh-agent -a ${FOLDER}/gha_77.sock`],
    ['extra words after the socket', `${OWN} -x`],
    ['another program with the same words', `not-ssh-agent -D -a ${FOLDER}/gha_77.sock`],
    ['a shell that merely mentions it', `sh -c ${OWN}`],
    ['an empty line', ''],
  ])('%s is not', (_name, args) => expect(ownAgentAccount(args, FOLDER)).toBeUndefined());
});

describe('the boot sweep (fake processes)', () => {
  const sweep = (table: AgentProcessTable, removed: string[] = [], uid = ME) =>
    sweepLeftoverAgents({
      leftovers: { table, uid, self: SELF },
      folder: FOLDER,
      remove: async name => void removed.push(name),
      clock: instant,
      log: quiet,
    });

  test('a stale socket plus a live agent: the agent is ended by pid and its socket removed', async () => {
    const world = machine([agent(5001, OWN)]);
    const removed: string[] = [];
    expect(await sweep(world.table, removed)).toBe(1);
    expect(world.signalled).toEqual([5001]);
    expect(world.alive()).toEqual([]);
    expect(removed).toEqual(['gha_77.sock']);
  });

  test('only this folder, this prefix, this uid: every other process is untouched', async () => {
    const world = machine([
      agent(5001, OWN),
      agent(5002, OWN, ME + 1),
      agent(5003, 'ssh-agent -D -a /other/state/git-accounts/downloads/gha_77.sock'),
      agent(5004, `ssh-agent -D -a ${FOLDER}/other_1.sock`),
      agent(5005, 'ssh-agent -l -a /tmp/ssh-AbCd/agent.9'),
      agent(5006, 'sleep 300'),
      agent(1, OWN),
      agent(SELF, OWN),
      agent(5007, `/usr/bin/ssh-agent -D -a ${FOLDER}/gha_88.sock`),
    ]);
    const removed: string[] = [];
    expect(await sweep(world.table, removed)).toBe(2);
    expect(world.signalled.sort()).toEqual([5001, 5007]);
    expect(world.alive().sort()).toEqual([1, SELF, 5002, 5003, 5004, 5005, 5006]);
    expect(removed.sort()).toEqual(['gha_77.sock', 'gha_88.sock']);
  });

  test('a daemon with no uid (-1) matches nobody', async () => {
    const world = machine([agent(5001, OWN)]);
    expect(await sweep(world.table, [], -1)).toBe(0);
    expect(world.signalled).toEqual([]);
  });

  test('nothing left behind: nothing signalled, nothing removed', async () => {
    const world = machine([agent(5006, 'sleep 300')]);
    const removed: string[] = [];
    expect(await sweep(world.table, removed)).toBe(0);
    expect(world.signalled).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('a process list that cannot be read ends the sweep: nothing is guessed', async () => {
    const warned: string[] = [];
    const table: AgentProcessTable = {
      list: async () => undefined,
      read: async () => undefined,
      terminate: () => {
        throw new Error('must not signal');
      },
    };
    const swept = await sweepLeftoverAgents({
      leftovers: { table, uid: ME, self: SELF },
      folder: FOLDER,
      remove: async () => {
        throw new Error('must not remove');
      },
      clock: instant,
      log: { warn: message => void warned.push(message) },
    });
    expect(swept).toBe(0);
    expect(warned).toHaveLength(1);
  });

  test('a table that throws never throws out of the sweep', async () => {
    const table: AgentProcessTable = {
      list: async () => {
        throw new Error('boom');
      },
      read: async () => undefined,
      terminate: () => false,
    };
    await expect(sweep(table)).resolves.toBe(0);
  });

  test('the killed agent is waited for: its socket is removed only after it has exited', async () => {
    let lists = 0;
    const events: string[] = [];
    const table: AgentProcessTable = {
      // The agent is still listed on the first look after the signal, and gone on the next.
      list: async () => (++lists <= 2 ? [agent(5001, OWN)] : []),
      read: async () => agent(5001, OWN),
      terminate: pid => (events.push(`terminate ${String(pid)}`), true),
    };
    await sweepLeftoverAgents({
      leftovers: { table, uid: ME, self: SELF },
      folder: FOLDER,
      remove: async name => void events.push(`remove ${name}`),
      clock: { sleep: async () => void events.push('wait') },
      log: quiet,
    });
    expect(events).toEqual(['terminate 5001', 'wait', 'remove gha_77.sock']);
  });

  test('a process that refuses the signal is not claimed as ended', async () => {
    const world = machine([agent(5001, OWN)], () => false);
    // Still listed afterwards, so the wait runs to its end (the clock is instant here).
    expect(await sweep(world.table)).toBe(0);
    expect(world.signalled).toEqual([5001]);
  });
});

describe('the supervisor ends leftovers BEFORE its first agent starts (boot)', () => {
  const ID = 'gha_77' as GitAccountId;
  const result = (exitCode: number): SpawnResult => ({ exitCode, signal: null, stdout: '', stderr: '' });

  test('socketFor (what warm asks for) sweeps once, first; a second account does not sweep again', async () => {
    const folder = tmpRunFolder();
    try {
      writeFileSync(`${folder.path}/${ID}.sock`, 'stale');
      writeFileSync(`${folder.path}/someone-else.sock`, 'not ours');
      const events: string[] = [];
      const own = `ssh-agent -D -a ${folder.path}/${ID}.sock`;
      let live = [agent(5001, own), agent(5002, `ssh-agent -D -a /elsewhere/${ID}.sock`)];
      const table: AgentProcessTable = {
        list: async () => live,
        read: async pid => live.find(entry => entry.pid === pid),
        terminate: pid => {
          events.push(
            `terminate ${String(pid)} stale-socket-present=${String(existsSync(`${folder.path}/${ID}.sock`))}`,
          );
          live = live.filter(entry => entry.pid !== pid);
          return true;
        },
      };
      const empty = () => new ReadableStream<Uint8Array>({ start: c => c.close() });
      const tools: Pick<SpawnPort, 'run' | 'start'> = {
        run: async (_program, args) => result(args[0] === '-' ? 0 : 1),
        start: (): ChildHandle => {
          events.push('start');
          return {
            pid: 9,
            stdout: empty(),
            stderr: empty(),
            write: () => undefined,
            kill: () => undefined,
            exited: new Promise(() => undefined),
            pipes: [],
            closePipes: () => undefined,
          };
        },
      };
      const supervisor = new AgentSupervisor(
        tools,
        folder,
        { after: () => () => undefined, sleep: async () => undefined },
        quiet,
        bareNames,
        {
          table,
          uid: ME,
          self: SELF,
        },
      );
      expect(await supervisor.socketFor(ID, async () => 'key')).toBe(`${folder.path}/${ID}.sock`);
      expect(await supervisor.socketFor('gha_78' as GitAccountId, async () => 'key')).toBe(
        `${folder.path}/gha_78.sock`,
      );
      // The stale agent was ended (while its socket was still there), then the new one started; the other folder's agent stays.
      expect(events).toEqual(['terminate 5001 stale-socket-present=true', 'start', 'start']);
      expect(live.map(entry => entry.pid)).toEqual([5002]);
      // Our stale socket file was replaced by the sweep's removal (the fake agent never binds a new one) and a stranger's stays.
      expect(existsSync(`${folder.path}/${ID}.sock`)).toBe(false);
      expect(existsSync(`${folder.path}/someone-else.sock`)).toBe(true);
      await supervisor.stopAll();
    } finally {
      folder.destroy();
    }
  });
});

describe('the pid is read again just before the signal (pid reuse)', () => {
  const sweep = (table: AgentProcessTable) =>
    sweepLeftoverAgents({
      leftovers: { table, uid: ME, self: SELF },
      folder: FOLDER,
      remove: async () => undefined,
      clock: instant,
      log: quiet,
    });
  const withRead = (now: AgentProcess | undefined) => {
    const signalled: number[] = [];
    const table: AgentProcessTable = {
      list: async () => [agent(5001, OWN)],
      read: async () => now,
      terminate: pid => (signalled.push(pid), true),
    };
    return { table, signalled };
  };

  test.each([
    ['the pid is gone', undefined],
    ['the pid now runs another program', agent(5001, 'sleep 300')],
    ['the pid now runs another agent line', agent(5001, `ssh-agent -D -a ${FOLDER}/gha_99.sock`)],
    ['the pid now belongs to another user', agent(5001, OWN, ME + 1)],
  ])('%s: it is NOT signalled', async (_name, now) => {
    const { table, signalled } = withRead(now);
    expect(await sweep(table)).toBe(0);
    expect(signalled).toEqual([]);
  });

  test('still the same agent of this uid: it is signalled', async () => {
    const { table, signalled } = withRead(agent(5001, OWN));
    expect(await sweep(table)).toBe(1);
    expect(signalled).toEqual([5001]);
  });
});

describe('the table is read without running ps on Linux, and with an absolute system ps elsewhere', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const tmp = () => {
    const root = mkdtempSync(`${tmpdir()}/e6-fake-`);
    roots.push(root);
    return root;
  };
  const neverRun = (calls: string[]): Pick<SpawnPort, 'run'> => ({
    run: async program => {
      calls.push(program);
      throw new Error('nothing may be run');
    },
  });

  test('Linux lists /proc entries (numeric names, a real command line, a plain uid) and runs nothing', async () => {
    const proc = tmp();
    const put = (pid: string, cmdline: string, uids: string) => {
      mkdirSync(`${proc}/${pid}`);
      writeFileSync(`${proc}/${pid}/cmdline`, cmdline);
      writeFileSync(`${proc}/${pid}/status`, `Name:\tx\nUid:\t${uids}\nGid:\t1\t1\t1\t1\n`);
    };
    put('4242', 'ssh-agent\0-D\0-a\0/my folder/gha_7.sock\0', '1000\t1000\t1000\t1000');
    put('4243', '', '1000\t1000\t1000\t1000');
    put('4244', 'su\0-c\0x\0', '1000\t0\t0\t0');
    mkdirSync(`${proc}/self`);
    const calls: string[] = [];
    const table = psAgentProcesses(neverRun(calls), { platform: 'linux', procRoot: proc });
    expect(await table.list()).toEqual([{ pid: 4242, uid: 1000, args: 'ssh-agent -D -a /my folder/gha_7.sock' }]);
    expect(await table.read(4242)).toEqual({ pid: 4242, uid: 1000, args: 'ssh-agent -D -a /my folder/gha_7.sock' });
    expect(await table.read(4244)).toBeUndefined();
    expect(await table.read(9999)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('Linux with no /proc answers undefined, never a ps', async () => {
    const calls: string[] = [];
    const table = psAgentProcesses(neverRun(calls), { platform: 'linux', procRoot: `${tmp()}/missing` });
    expect(await table.list()).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('macOS runs only an absolute system ps, never the bare name', async () => {
    const root = tmp();
    writeFileSync(`${root}/ps`, '#!/bin/sh\n');
    chmodSync(`${root}/ps`, 0o755);
    const runs: string[] = [];
    const table = psAgentProcesses(
      {
        run: async program => {
          runs.push(program);
          return { exitCode: 0, signal: null, stdout: ' 77 501 ssh-agent -D -a /x/gha_1.sock\n', stderr: '' };
        },
      },
      { platform: 'darwin', systemPs: [`${root}/missing-ps`, `${root}/ps`] },
    );
    expect(await table.list()).toEqual([{ pid: 77, uid: 501, args: 'ssh-agent -D -a /x/gha_1.sock' }]);
    expect(await table.read(77)).toEqual({ pid: 77, uid: 501, args: 'ssh-agent -D -a /x/gha_1.sock' });
    expect(runs).toEqual([`${root}/ps`, `${root}/ps`]);
  });

  test('macOS with no system ps fails closed: undefined, nothing run', async () => {
    const calls: string[] = [];
    const table = psAgentProcesses(neverRun(calls), { platform: 'darwin', systemPs: [`${tmp()}/nope`] });
    expect(await table.list()).toBeUndefined();
    expect(await table.read(77)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('a pid of 0 or 1 is never signalled, and a signal that throws answers false', () => {
    const sent: number[] = [];
    const table = psAgentProcesses(neverRun([]), {
      platform: 'linux',
      kill: pid => {
        sent.push(pid);
        if (pid === 9) throw new Error('ESRCH');
      },
    });
    expect([
      table.terminate(0),
      table.terminate(1),
      table.terminate(-5),
      table.terminate(9),
      table.terminate(10),
    ]).toEqual([false, false, false, false, true]);
    expect(sent).toEqual([9, 10]);
  });
});

describe('ps parsing', () => {
  test('pid, uid and the whole command line, spaces kept; lines that are not three columns are skipped', () => {
    expect(
      parsePsListing(
        [
          '    1     0 /sbin/init splash',
          ' 4242  1000 ssh-agent -D -a /my folder/gha_7.sock  ',
          'garbage',
          '',
          '  77 1000',
        ].join('\n'),
      ),
    ).toEqual([
      { pid: 1, uid: 0, args: '/sbin/init splash' },
      { pid: 4242, uid: 1000, args: 'ssh-agent -D -a /my folder/gha_7.sock' },
    ]);
  });
});

const HAVE = ['bash', 'ps', 'sleep'].every(tool => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0);
const getuid = process.getuid?.bind(process);

/**
 * Real processes, started HERE, in temp folders of their own: a `bash` waiting on its stdin whose argv[0] reads like the
 * agent's command line (`bash -c 'exec -a …'`). Nothing else on the machine can match a path inside these temp folders, and each one is
 * stopped by its own pid in `afterEach` whatever happens.
 */
describe.skipIf(!HAVE || getuid === undefined || process.platform !== 'linux')(
  'the real ps listing and SIGTERM, on processes this test starts',
  () => {
    const started: Array<ReturnType<typeof Bun.spawn>> = [];
    const folders: Array<ReturnType<typeof tmpRunFolder>> = [];
    const roots: string[] = [];
    afterEach(() => {
      for (const child of started.splice(0)) child.kill('SIGKILL');
      for (const folder of folders.splice(0)) folder.destroy();
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    const fakeAgent = (socket: string) => {
      // A `bash` that waits on its (open) stdin, with the agent's command line as its argv[0] and no other argument.
      const child = Bun.spawn(['bash', '-c', 'exec -a "$0" bash', `ssh-agent -D -a ${socket}`], {
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      started.push(child);
      return child;
    };
    const spawn = () => {
      const real = bunSpawn({ PATH: process.env.PATH ?? '' }, () => undefined, {}, { PATH: process.env.PATH ?? '' });
      return { run: real.run.bind(real) };
    };
    const waitFor = async (check: () => boolean | Promise<boolean>) => {
      for (let at = 0; at < 100; at += 1) {
        if (await check()) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    };

    test('a stale folder plus a live pid: both are gone after the sweep; a folder that is not ours is untouched', async () => {
      const folder = tmpRunFolder();
      folders.push(folder);
      const strangers = mkdtempSync(`${tmpdir()}/e6-other-`);
      roots.push(strangers);
      const ours = fakeAgent(`${folder.path}/gha_77.sock`);
      const theirs = fakeAgent(`${strangers}/gha_77.sock`);
      // Files as the dead daemon left them: our socket, and a foreign one in the same folder.
      closeSync(openSync(`${folder.path}/gha_77.sock`, 'w'));
      closeSync(openSync(`${folder.path}/stranger.sock`, 'w'));
      closeSync(openSync(`${strangers}/gha_77.sock`, 'w'));
      const table = psAgentProcesses(spawn());
      // The fake agents are listed under their command lines before the sweep…
      expect(
        await waitFor(async () => {
          const listed = (await table.list()) ?? [];
          // By command line too: until `bash` has `exec`ed, its pid is listed under the `bash -c …` it started with.
          return [
            [ours.pid, `${folder.path}/gha_77.sock`],
            [theirs.pid, `${strangers}/gha_77.sock`],
          ].every(([pid, socket]) =>
            listed.some(entry => entry.pid === pid && entry.args === `ssh-agent -D -a ${socket as string}`),
          );
        }),
      ).toBe(true);
      const swept = new AgentSupervisor(
        {
          run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: '' }),
          start: () => {
            throw new Error('no agent here');
          },
        },
        folder,
        { after: () => () => undefined, sleep: delay => new Promise(resolve => setTimeout(resolve, delay)) },
        quiet,
        bareNames,
        { table, uid: getuid?.() ?? -1, self: process.pid },
      );
      await swept.sweepLeftovers();
      // …and after it: ours ended and its socket gone; the other folder's process, its socket and ours-but-not-an-agent stay.
      expect(await waitFor(() => ours.exitCode !== null || ours.signalCode !== null)).toBe(true);
      expect(existsSync(`${folder.path}/gha_77.sock`)).toBe(false);
      expect(existsSync(`${folder.path}/stranger.sock`)).toBe(true);
      expect(theirs.exitCode).toBeNull();
      expect(theirs.signalCode).toBeNull();
      expect(existsSync(`${strangers}/gha_77.sock`)).toBe(true);
      expect(((await table.list()) ?? []).some(entry => entry.pid === theirs.pid)).toBe(true);
    }, 30_000);
  },
);

/**
 * A `ps` planted EARLIER on the daemon's `PATH` (a shim folder, another install's shims, a symlink alias) must never be
 * run: it would name any same-user pid as "ours" and the sweep would SIGTERM it. Everything here is a temp folder and a
 * decoy this test started itself; no process of the machine is ever signalled.
 */
describe.skipIf(!HAVE || getuid === undefined || process.platform !== 'linux')(
  'a planted ps earlier on PATH is not used (Linux reads /proc, runs nothing)',
  () => {
    const cleanup: Array<() => void> = [];
    afterEach(() => {
      for (const undo of cleanup.splice(0)) undo();
    });

    test('the sweep does not run the planted ps and the decoy it names is NOT signalled', async () => {
      const folder = tmpRunFolder();
      const planted = mkdtempSync(`${tmpdir()}/e6-plant-`);
      // The decoy: a process of ours that is NOT an agent (its command line is plain `sleep`).
      const decoy = Bun.spawn(['sleep', '300'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      cleanup.push(() => {
        decoy.kill('SIGKILL');
        folder.destroy();
        rmSync(planted, { recursive: true, force: true });
      });
      const marker = `${planted}/ran`;
      // The fake `ps` records that it ran and claims the decoy is this plugin's own agent.
      writeFileSync(
        `${planted}/ps`,
        `#!/bin/sh\n: > '${marker}'\nprintf '%s %s %s\\n' ${decoy.pid} ${getuid?.() ?? 0} 'ssh-agent -D -a ${folder.path}/gha_77.sock'\n`,
      );
      chmodSync(`${planted}/ps`, 0o755);
      const path = `${planted}:${process.env.PATH ?? ''}`;
      const real = bunSpawn({ PATH: path }, () => undefined, {}, { PATH: path });
      const table = psAgentProcesses({ run: real.run.bind(real) });
      const swept = await sweepLeftoverAgents({
        leftovers: { table, uid: getuid?.() ?? -1, self: process.pid },
        folder: folder.path,
        remove: async () => undefined,
        clock: { sleep: async () => undefined },
        log: quiet,
      });
      expect(existsSync(marker)).toBe(false);
      expect(swept).toBe(0);
      expect(decoy.exitCode).toBeNull();
      expect(decoy.signalCode).toBeNull();
    }, 30_000);
  },
);
