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
 * A machine with NO tmux server running — every machine after a reboot. tmux exits a server with no session at once
 * (`exit-empty`), so a launch that read the server's options after a bare `start-server` found no server and refused
 * to start ("unavailable"). Everything here runs on a private socket in a temp directory; the owner's own tmux server
 * and default socket are never touched, and only this test's own server is killed.
 */
const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('TmuxRunner start with no tmux server running', () => {
  it('should start a ferret on a private socket that has no server, and keep its values out of the server', async () => {
    // Arrange
    if (TMUX === null) throw new Error('tmux is required for this test and was not found');
    const root = await mkdtemp(join(tmpdir(), 'fy-noserver-'));
    const socket = join(root, 's');
    const tmux = new BunTmuxProcess(TMUX, socket);
    cleanups.push(async () => {
      await tmux.execute(['kill-server']);
      await rm(root, { recursive: true, force: true });
    });
    should((await tmux.execute(['has-session'])).code).not.equal(0);
    const handle = Object.freeze({ names: ['FY_PROBE'] }) as unknown as ChildEnvironment;
    const spawn = bunSpawn(process.env as Record<string, string>, () => ({
      open: env =>
        env === handle ? { PATH: process.env['PATH'] ?? '/usr/bin:/bin', FY_PROBE: 'only-in-the-pane' } : undefined,
      searchPathOf: () => undefined,
    }));
    const runner = new TmuxRunner({
      tmux,
      spawn,
      socketPath: socket,
      instantOf: () => 'then' as never,
      now: () => 'now' as never,
    });
    const seen = join(root, 'seen');

    // Act
    const started = await runner.start({
      ferret: ferretId('nosrv'),
      command: ['sh', '-c', `printf %s "$FY_PROBE" > '${seen}'; sleep 30`],
      cwd: fenced(root),
      env: handle,
    });

    // Assert
    should(started.ok ? undefined : started.error).equal(undefined);
    if (!started.ok) return;
    should(started.value.handle).match(/^%\d+$/u);
    await waitFor(
      async () => (await readFile(seen, 'utf8').catch(() => '')) !== '',
      'the pane to read its environment',
    );
    should(await readFile(seen, 'utf8')).equal('only-in-the-pane');
    should((await tmux.execute(['has-session', '-t', 'fy-nosrv'])).code).equal(0);
    // The server never held the value, and the server options are back as they were.
    should((await tmux.execute(['show-environment', '-g', 'FY_PROBE'])).code).not.equal(0);
    const updateEnvironment = await tmux.execute(['show-options', '-gv', 'update-environment']);
    should(updateEnvironment.stdout).not.containEql('FY_PROBE');
    should((await tmux.execute(['show-options', '-sv', 'exit-empty'])).stdout.trim()).equal('on');
  });
});
