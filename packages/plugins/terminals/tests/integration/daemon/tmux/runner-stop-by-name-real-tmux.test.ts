import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenced, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { ChildEnvironment } from '@ferretry/core-vault/contract';
import { bunSpawn } from '@ferretry/kernel/host';
import should from 'should';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * A polite stop through a STALE handle, over a REAL tmux server on a private socket in a temp directory (the owner's own
 * tmux server and default socket are never touched, and only this test's server is killed). The fake tmux every other
 * stop test uses answers 0 to every `send-keys`, so it cannot tell a target tmux accepts from one it refuses: real tmux
 * rejects `send-keys -t =fy-abc` ("can't find pane") and takes `=fy-abc:`. Two ferrets whose ids share a prefix (`abc`,
 * `abcxx`) prove the interrupt reaches exactly `fy-abc`, and not `fy-abcxx`.
 */
const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const exists = async (path: string) =>
  await readFile(path, 'utf8').then(
    () => true,
    () => false,
  );

async function world() {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-stop-name-'));
  const socket = join(root, 's');
  const tmux = new BunTmuxProcess(TMUX, socket);
  cleanups.push(async () => {
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
  });
  /** A pane whose shell writes `hit-<name>` when it takes a Ctrl-C and `tick-<name>` on every beat. */
  const launch = async (name: string) => {
    const script = `trap 'touch "${root}/hit-${name}"' INT; while :; do echo t >> "${root}/tick-${name}"; sleep 0.2; done`;
    const started = await runner.start({
      ferret: ferretId(name),
      command: ['sh', '-c', script],
      cwd: fenced(root),
      env: handle,
    });
    if (!started.ok) throw new Error(`the pane did not start: ${JSON.stringify(started.error)}`);
    return started.value.handle;
  };
  const ticks = async (name: string) =>
    (await readFile(join(root, `tick-${name}`), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  return { root, runner, launch, ticks };
}

describe('TmuxRunner polite stop by name over a real tmux server', () => {
  it.skipIf(process.platform !== 'linux')(
    "should interrupt the named ferret's own session through a stale handle, and not a session whose id it prefixes",
    async () => {
      // Arrange — `abc`'s record carries the handle of ANOTHER ferret's pane (`abcxx`'s): the stale handle
      const { root, runner, launch, ticks } = await world();
      await launch('abc');
      const stale = await launch('abcxx');
      await waitFor(async () => (await ticks('abc')) > 0 && (await ticks('abcxx')) > 0, 'both panes to run');

      // Act
      await runner.stop(stale, 'polite', ferretId('abc'));

      // Assert
      await waitFor(() => exists(join(root, 'hit-abc')), 'the interrupt to reach fy-abc');
      const beat = await ticks('abcxx');
      await waitFor(async () => (await ticks('abcxx')) >= beat + 3, 'fy-abcxx to keep beating');
      should(await exists(join(root, 'hit-abcxx'))).equal(false);
    },
  );
});
