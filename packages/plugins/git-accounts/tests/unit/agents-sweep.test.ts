import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
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
import { tmpRunFolder } from './run-folder.ts';

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
          return [ours.pid, theirs.pid].every(pid => listed.some(entry => entry.pid === pid));
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
