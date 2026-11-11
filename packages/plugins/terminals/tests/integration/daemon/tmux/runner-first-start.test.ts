/**
 * The FIRST ferret start on a fresh daemon, over a real tmux: no server, no session, no keeper.
 *
 * With no session on the socket tmux's `exit-empty` ends the server as soon as the client that started it is
 * done, so a launch that read the server's options from one client and created the session from another
 * found no server to ask and answered `runner_unavailable`, whatever the login. The launch must hold the server
 * up between its own clients — and still never start it with a ferret's values in its environment.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenced, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { ChildEnvironment } from '@ferretry/kernel/contract';
import { bunSpawn } from '@ferretry/kernel/host';
import should from 'should';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';

const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void>)[] = [];
const SECRET = 'first-start-secret-value-7731';

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freshServer() {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-first-start-'));
  const socket = join(root, 's');
  const direct = new BunTmuxProcess(TMUX, socket);
  cleanups.push(async () => {
    await direct.execute(['kill-server']);
    await rm(root, { recursive: true, force: true });
  });
  // The daemon's own environment, minus any tmux this test happens to run inside.
  const { TMUX: _outer, TMUX_PANE: _pane, ...base } = process.env as Record<string, string>;
  const spawn = bunSpawn(base, () => ({
    open: () => ({ FERRET_PROBE_SECRET: SECRET }),
    searchPathOf: () => undefined,
  }));
  const runner = new TmuxRunner({
    tmux: direct,
    spawn,
    socketPath: socket,
    instantOf: () => 'then' as never,
    now: () => 'now' as never,
  });
  return { root, direct, runner };
}

describe('TmuxRunner first start over a real tmux', () => {
  it('should start the first ferret on a fresh server with no session, and keep its values out of the server', async () => {
    // Arrange
    const { root, direct, runner } = await freshServer();
    should((await direct.execute(['has-session'])).code).not.equal(0);

    // Act
    const started = await runner.start({
      ferret: ferretId('first'),
      command: ['sleep', '30'],
      cwd: fenced(root),
      env: Object.freeze({ names: ['FERRET_PROBE_SECRET'] }) as unknown as ChildEnvironment,
    });

    // Assert
    should(started.ok ? 'started' : started.error).equal('started');
    const sessions = await direct.execute(['list-sessions', '-F', '#{session_name}']);
    should(sessions.stdout.trim()).equal('fy-first');
    const serverEnvironment = await direct.execute(['show-environment', '-g']);
    should(serverEnvironment.stdout).not.containEql(SECRET);
    should((await direct.execute(['show-options', '-sv', 'exit-empty'])).stdout.trim()).equal('on');
    should((await direct.execute(['show-options', '-gv', 'update-environment'])).stdout).not.containEql(
      'FERRET_PROBE_SECRET',
    );
  });
});
