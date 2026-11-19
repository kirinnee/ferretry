import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildHandle, Clock, SpawnOptions, SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import { bunSpawn } from '@ferretry/kernel/host';
import type { GitAccountId } from '../../contract/index.ts';
import { AgentSupervisor } from '../../daemon/features/ssh-keys/agents.ts';
import { tmpRunFolder } from './run-folder.ts';

const ID = 'gha_77' as GitAccountId;
const HAVE_TOOLS = ['ssh-agent', 'ssh-add', 'ssh-keygen'].every(
  tool => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0,
);

const folder = tmpRunFolder();
afterAll(() => folder.destroy());

type Tools = Pick<SpawnPort, 'run' | 'start'>;
type Timers = Pick<Clock, 'sleep' | 'after'>;

/** A clock the test drives: the deadline fires on `fire()`, and `sleep` either ends at once or holds until aborted. */
function stubClock(hold: boolean) {
  const deadlines: Array<() => void> = [];
  const clock: Timers = {
    after: (_delay, fn) => {
      deadlines.push(fn);
      return () => void deadlines.splice(deadlines.indexOf(fn), 1);
    },
    sleep: (_delay, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) return reject(new Error('aborted'));
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
        if (!hold) setTimeout(resolve, 0);
      }),
  };
  return {
    clock,
    fire: () => {
      for (const fn of deadlines.splice(0)) fn();
    },
    pending: () => deadlines.length,
  };
}

const realClock: Timers = {
  after: (delay, fn) => {
    const timer = setTimeout(fn, delay);
    return () => clearTimeout(timer);
  },
  sleep: delay => new Promise(resolve => setTimeout(resolve, delay)),
};

const quiet = { warn: () => undefined };
const PRIVATE = 'not-a-real-key';
const key = () => Promise.resolve(PRIVATE);

/** Agent children that never print and never end, and `ssh-add` answers a test scripts. */
function scripted(answer: (program: string, args: readonly string[]) => Promise<SpawnResult> | SpawnResult) {
  const runs: Array<{ program: string; args: readonly string[] }> = [];
  const killed: string[] = [];
  const empty = () => new ReadableStream<Uint8Array>({ start: c => c.close() });
  const tools: Tools = {
    run: async (program, args) => {
      runs.push({ program, args });
      return await answer(program, args);
    },
    start: (_program, args): ChildHandle => ({
      pid: 1,
      stdout: empty(),
      stderr: empty(),
      write: () => undefined,
      kill: signal => void killed.push(`${args.at(-1) ?? ''}:${signal ?? 'SIGTERM'}`),
      exited: new Promise(() => undefined),
      pipes: [],
      closePipes: () => undefined,
    }),
  };
  return { tools, runs, killed };
}

const result = (exitCode: number): SpawnResult => ({ exitCode, signal: null, stdout: '', stderr: '' });
const hasAdd = (runs: ReadonlyArray<{ program: string; args: readonly string[] }>) =>
  runs.some(call => call.program === 'ssh-add' && call.args[0] === '-');

describe('an agent that is slow, hung or in the way of a stop (fake processes)', () => {
  test('a probe that fails, then an agent that answers: the wait goes on until it can read the agent', async () => {
    let probes = 0;
    const { tools } = scripted((_program, args) => {
      if (args[0] !== '-l') return result(0);
      probes += 1;
      if (probes === 1) throw new Error('could not spawn');
      return result(probes === 2 ? 2 : 1);
    });
    const supervisor = new AgentSupervisor(tools, folder, stubClock(false).clock, quiet);
    expect(await supervisor.socketFor(ID, key)).toBe(`${folder.path}/gha_77.sock`);
    expect(probes).toBe(3);
    await supervisor.stopAll();
  });

  test('an agent that never listens ends the whole wait at the deadline: 503, the child killed, the key never sent', async () => {
    const { tools, runs, killed } = scripted(() => result(2));
    const time = stubClock(true);
    const supervisor = new AgentSupervisor(tools, folder, time.clock, quiet);
    const asked = supervisor.socketFor(ID, key);
    const outcome = asked.then(
      () => undefined,
      (error: unknown) => error,
    );
    while (runs.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
    time.fire();
    expect(await outcome).toMatchObject({ status: 503 });
    expect(killed).toHaveLength(1);
    expect(hasAdd(runs)).toBe(false);
    expect(time.pending()).toBe(0);
    await supervisor.stopAll();
  });

  test('a probe that never returns cannot hold the wait past the deadline either', async () => {
    const { tools, runs, killed } = scripted(() => new Promise<SpawnResult>(() => undefined));
    const time = stubClock(true);
    const supervisor = new AgentSupervisor(tools, folder, time.clock, quiet);
    const asked = supervisor.socketFor(ID, key);
    const outcome = asked.then(
      () => undefined,
      (error: unknown) => error,
    );
    while (runs.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
    time.fire();
    expect(await outcome).toMatchObject({ status: 503 });
    expect(killed).toHaveLength(1);
    await supervisor.stopAll();
  });

  test('a stop while the agent is still coming up: it ends, and the key was never sent to it', async () => {
    const gate = Promise.withResolvers<SpawnResult>();
    const { tools, runs, killed } = scripted(async (_program, args) =>
      args[0] === '-l' ? await gate.promise : result(0),
    );
    const supervisor = new AgentSupervisor(tools, folder, stubClock(false).clock, quiet);
    const asked = supervisor.socketFor(ID, key);
    const outcome = asked.then(
      () => undefined,
      (error: unknown) => error,
    );
    while (runs.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
    await supervisor.stopAll();
    gate.resolve(result(1));
    expect(await outcome).toMatchObject({ status: 503 });
    expect(killed).toHaveLength(1);
    expect(hasAdd(runs)).toBe(false);
  });

  test('a stop while the key is going in: the agent that took it is killed, not left running', async () => {
    const gate = Promise.withResolvers<SpawnResult>();
    const { tools, runs, killed } = scripted(async (_program, args) =>
      args[0] === '-' ? await gate.promise : result(1),
    );
    const supervisor = new AgentSupervisor(tools, folder, stubClock(false).clock, quiet);
    const asked = supervisor.socketFor(ID, key);
    const outcome = asked.then(
      () => undefined,
      (error: unknown) => error,
    );
    while (!hasAdd(runs)) await new Promise(resolve => setTimeout(resolve, 1));
    await supervisor.stopAll();
    gate.resolve(result(0));
    expect(await outcome).toMatchObject({ status: 503 });
    expect(killed).toHaveLength(1);
    // And nothing is left to hand out afterwards.
    await expect(supervisor.socketFor(ID, key)).rejects.toMatchObject({ status: 503 });
  });
});

describe.skipIf(!HAVE_TOOLS)('the real kernel spawn with a real ssh-agent (skipped without the tools)', () => {
  const realSpawn = () => {
    const spawn = bunSpawn({ PATH: process.env.PATH ?? '' }, () => undefined, {}, { PATH: process.env.PATH ?? '' });
    const started: ChildHandle[] = [];
    const tools: Tools = {
      run: (program, args, options?: SpawnOptions) => spawn.run(program, args, options),
      start: (program, args, options) => {
        const child = spawn.start(program, args, options);
        started.push(child);
        return child;
      },
    };
    return { tools, started };
  };
  // A throwaway key made here, never one of anybody's.
  const keyText = async (): Promise<string> => {
    const dir = mkdtempSync(`${tmpdir()}/b3k-`);
    try {
      spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'b3-test', '-f', `${dir}/id`]);
      return await Bun.file(`${dir}/id`).text();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('an agent starts every time through the kernel spawn: its output is read, so it never dies of SIGPIPE', async () => {
    const privateKey = await keyText();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { tools, started } = realSpawn();
      const supervisor = new AgentSupervisor(tools, folder, realClock, quiet);
      try {
        const socket = await supervisor.socketFor(ID, () => Promise.resolve(privateKey));
        expect(socket).toBeDefined();
        expect(started).toHaveLength(1);
      } finally {
        await supervisor.stopAll();
      }
    }
  }, 60_000);

  test('an agent killed uncleanly leaves its socket behind and the next start binds the SAME path again', async () => {
    const privateKey = await keyText();
    const { tools, started } = realSpawn();
    const supervisor = new AgentSupervisor(tools, folder, realClock, quiet);
    try {
      const first = (await supervisor.socketFor(ID, () => Promise.resolve(privateKey))) as string;
      started[0]?.kill('SIGKILL');
      await started[0]?.exited;
      expect(existsSync(first)).toBe(true);
      const second = (await supervisor.socketFor(ID, () => Promise.resolve(privateKey))) as string;
      // A ferret holding the old `SSH_AUTH_SOCK` still means the right agent.
      expect(second).toBe(first);
      expect(started).toHaveLength(2);
    } finally {
      await supervisor.stopAll();
    }
  }, 30_000);

  test('a daemon restart or update: the new supervisor serves the same socket path, and the old ferret’s ssh-add still works', async () => {
    const privateKey = await keyText();
    const first = realSpawn();
    const one = new AgentSupervisor(first.tools, folder, realClock, quiet);
    const socket = (await one.socketFor(ID, () => Promise.resolve(privateKey))) as string;
    const known = await one.knownHostsFile();
    await one.stopAll();
    expect(spawnSync('ssh-add', ['-l'], { env: { PATH: process.env.PATH ?? '', SSH_AUTH_SOCK: socket } }).status).toBe(
      2,
    );
    const second = realSpawn();
    const two = new AgentSupervisor(second.tools, folder, realClock, quiet);
    try {
      expect(await two.socketFor(ID, () => Promise.resolve(privateKey))).toBe(socket);
      expect(await two.knownHostsFile()).toBe(known);
      const listed = spawnSync('ssh-add', ['-l'], {
        env: { PATH: process.env.PATH ?? '', SSH_AUTH_SOCK: socket },
        encoding: 'utf8',
      });
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain('SHA256:');
    } finally {
      await two.stopAll();
    }
  }, 30_000);
});

describe('a stable path (fake processes)', () => {
  test('the socket, the known_hosts and the public key sit in one private folder at the same path on every run', async () => {
    const { tools } = scripted((_program, args) => result(args[0] === '-' ? 0 : 1));
    const first = new AgentSupervisor(tools, folder, stubClock(false).clock, quiet);
    const socket = await first.socketFor(ID, key);
    const known = await first.knownHostsFile();
    const pub = await first.publicKeyFile(ID, 'ssh-ed25519 AAAA key');
    expect([socket, known, pub]).toEqual([
      `${folder.path}/gha_77.sock`,
      `${folder.path}/known_hosts`,
      `${folder.path}/gha_77.pub`,
    ]);
    await first.stopAll();
    // The daemon restarts: a new supervisor, the same paths; nothing was removed with the old one.
    expect(existsSync(known)).toBe(true);
    expect(statSync(known).mode & 0o777).toBe(0o600);
    expect(statSync(folder.path).mode & 0o777).toBe(0o700);
    const second = new AgentSupervisor(tools, folder, stubClock(false).clock, quiet);
    expect(await second.socketFor(ID, key)).toBe(socket);
    expect(await second.knownHostsFile()).toBe(known);
    await second.stopAll();
  });

  test('a stale socket file is removed before the agent binds, and an agent that is stopping is waited for first', async () => {
    const order: string[] = [];
    const exit = Promise.withResolvers<number | null>();
    let starts = 0;
    const empty = () => new ReadableStream<Uint8Array>({ start: c => c.close() });
    const tools: Tools = {
      run: async (_program, args) => result(args[0] === '-' ? 0 : 1),
      start: (): ChildHandle => {
        starts += 1;
        const mine = starts;
        order.push(`start ${String(mine)}`);
        return {
          pid: mine,
          stdout: empty(),
          stderr: empty(),
          write: () => undefined,
          kill: () => void order.push(`kill ${String(mine)}`),
          exited: mine === 1 ? exit.promise : new Promise(() => undefined),
          pipes: [],
          closePipes: () => undefined,
        };
      },
    };
    const supervisor = new AgentSupervisor(tools, folder, stubClock(true).clock, quiet);
    await supervisor.socketFor(ID, key);
    supervisor.stop(ID);
    const again = supervisor.socketFor(ID, key);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toEqual(['start 1', 'kill 1']);
    exit.resolve(0);
    await again;
    expect(order).toEqual(['start 1', 'kill 1', 'start 2']);
  });

  test('a folder that is not private, or a path too long for a socket, starts nothing', async () => {
    const { tools, runs } = scripted(() => result(1));
    const open = new AgentSupervisor(tools, { ...folder, isPrivate: async () => false }, stubClock(false).clock, quiet);
    await expect(open.socketFor(ID, key)).rejects.toMatchObject({ status: 503 });
    const long = new AgentSupervisor(tools, { ...folder, path: `/${'x'.repeat(120)}` }, stubClock(false).clock, quiet);
    await expect(long.socketFor(ID, key)).rejects.toMatchObject({ status: 503 });
    expect(runs).toHaveLength(0);
  });
});
