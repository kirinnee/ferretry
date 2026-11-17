import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import should from 'should';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';

/**
 * FX4: a private tmux server that is UP but holds no session (started before the daemon with `exit-empty` off, as a
 * service manager or the upgrade kit does, or left so after every pane ended). Real tmux on that server answers
 * `has-session -t =fy-<id>` with `no current target`, not `can't find session`, so `gone` proved nothing, the boot
 * auto-resume and the 30 s gone sweep observed nothing, and every converted `working` ferret stayed working with no
 * pane. Everything runs on a private socket in a temp directory; only this test's own server is killed.
 */
const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function privateServer(): Promise<{ readonly tmux: BunTmuxProcess; readonly runner: TmuxRunner }> {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-empty-'));
  const socket = join(root, 's');
  const tmux = new BunTmuxProcess(TMUX, socket);
  cleanups.push(async () => {
    await tmux.execute(['kill-server']);
    await rm(root, { recursive: true, force: true });
  });
  const runner = new TmuxRunner({
    tmux,
    spawn: {
      run: () => Promise.reject(new Error('gone must not spawn')),
      runBytes: () => Promise.reject(new Error('gone must not spawn')),
      start: () => {
        throw new Error('gone must not spawn');
      },
    },
    socketPath: socket,
    instantOf: () => 'then' as never,
    now: () => 'now' as never,
  });
  return { tmux, runner };
}

describe('FX4 TmuxRunner.gone on a server that holds no session', () => {
  it('FX4 should prove a ferret gone when its private server is up with no session at all', async () => {
    // Arrange
    const { tmux, runner } = await privateServer();
    should((await tmux.execute(['start-server', ';', 'set-option', '-s', 'exit-empty', 'off'])).code).equal(0);
    const listed = await tmux.execute(['list-sessions', '-F', '#{session_name}']);
    should(listed.code).equal(0);
    should(listed.stdout.trim()).equal('');

    // Act
    const gone = await runner.gone(ferretId('emptysrv'));

    // Assert
    should(gone).be.true();
  });

  it('FX4 should still find a live ferret session on that server not gone, and another ferret gone', async () => {
    // Arrange
    const { tmux, runner } = await privateServer();
    should((await tmux.execute(['start-server', ';', 'set-option', '-s', 'exit-empty', 'off'])).code).equal(0);
    should((await tmux.execute(['new-session', '-d', '-s', 'fy-livesrv', 'sleep 30'])).code).equal(0);

    // Act / Assert
    should(await runner.gone(ferretId('livesrv'))).be.false();
    should(await runner.gone(ferretId('othersrv'))).be.true();
  });
});
