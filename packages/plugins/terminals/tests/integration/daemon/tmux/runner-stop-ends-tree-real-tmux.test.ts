import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenced, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { ChildEnvironment } from '@ferretry/core-vault/contract';
import { bunSpawn } from '@ferretry/kernel/host';
import should from 'should';
import { paneProcessHost } from '../../../../daemon/adapters/tmux/pane-process-host.ts';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * A stopped ferret is GONE: after every stop path returns, there is no `fy-<id>` tmux session and no process of its tree
 * left, whatever the agent does with the signals. The fake agent ignores HUP, INT and TERM (what `kill-session` sends is
 * HUP), and starts a helper that ignores them too (`fy mcp serve`'s part). The tmux server is a PRIVATE one on a socket in
 * a temp directory: the owner's own tmux server, sessions and default socket are never reached, and only this test's
 * server is killed.
 */
const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function world() {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-stop-tree-'));
  const socket = join(root, 's');
  const tmux = new BunTmuxProcess(TMUX, socket);
  const pids: number[] = [];
  cleanups.push(async () => {
    // Whatever a failing test left running is killed by its own recorded pid (never by name).
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await tmux.execute(['kill-server']);
    await rm(root, { recursive: true, force: true });
  });
  const handle = Object.freeze({ names: [] }) as unknown as ChildEnvironment;
  const spawn = bunSpawn(process.env as Record<string, string>, () => ({
    open: env => (env === handle ? { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } : undefined),
    searchPathOf: () => undefined,
  }));
  const runner = new TmuxRunner({
    tmux,
    spawn,
    socketPath: socket,
    instantOf: () => 'then' as never,
    now: () => 'now' as never,
    processes: paneProcessHost(spawn),
    sleep: async ms => await Bun.sleep(ms),
    politeGraceMs: 300,
    treeEnd: { stepMs: 1_500, pollMs: 25 },
  });
  const script = join(root, 'agent.sh');
  await writeFile(
    script,
    [
      '#!/bin/sh',
      'trap "" HUP INT TERM',
      `sh -c 'trap "" HUP INT TERM; echo $$ > "${root}/helper-$1"; while :; do sleep 0.2; done' sh "$1" &`,
      `echo $$ > "${root}/agent-$1"`,
      'while :; do sleep 0.2; done',
    ].join('\n'),
  );
  await chmod(script, 0o755);
  const launch = async (name: string) => {
    const started = await runner.start({
      ferret: ferretId(name),
      command: ['sh', script, name],
      cwd: fenced(root),
      env: handle,
    });
    if (!started.ok) throw new Error(`the pane did not start: ${JSON.stringify(started.error)}`);
    const read = async (file: string) => Number((await readFile(join(root, file), 'utf8').catch(() => '')).trim());
    await waitFor(
      async () => (await read(`agent-${name}`)) > 0 && (await read(`helper-${name}`)) > 0,
      'the agent and its helper',
    );
    const agent = await read(`agent-${name}`);
    const helper = await read(`helper-${name}`);
    pids.push(agent, helper);
    return { handle: started.value.handle, agent, helper };
  };
  const sessions = async () =>
    (await tmux.execute(['list-sessions', '-F', '#{session_name}'])).stdout.split('\n').filter(Boolean);
  return { launch, sessions, runner };
}

describe.skipIf(process.platform !== 'linux')('TmuxRunner stop ends the session AND the whole process tree', () => {
  for (const how of ['polite', 'now'] as const) {
    it(`should leave no session and no process after a ${how} stop of an agent that ignores every signal`, async () => {
      // Arrange
      const { launch, sessions, runner } = await world();
      const { handle, agent, helper } = await launch('abc');
      const bystander = await launch('abcxx');
      should(alive(agent) && alive(helper)).equal(true);

      // Act
      await runner.stop(handle, how, ferretId('abc'));

      // Assert — gone by the time the stop answers, and nobody else's pane was touched
      should(await sessions()).eql([`fy-abcxx`]);
      should(alive(agent)).equal(false);
      should(alive(helper)).equal(false);
      should(alive(bystander.agent) && alive(bystander.helper)).equal(true);
    });
  }

  it("should end the ferret through a stale handle (another ferret's pane id) by its exact session name", async () => {
    // Arrange — `abc`'s record carries the handle of ANOTHER ferret's pane
    const { launch, sessions, runner } = await world();
    const own = await launch('abc');
    const other = await launch('abcxx');

    // Act
    await runner.stop(other.handle, 'polite', ferretId('abc'));

    // Assert
    should(await sessions()).eql(['fy-abcxx']);
    should(alive(own.agent) || alive(own.helper)).equal(false);
    should(alive(other.agent) && alive(other.helper)).equal(true);
  });
});
