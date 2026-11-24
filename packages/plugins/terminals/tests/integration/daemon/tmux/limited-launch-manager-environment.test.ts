import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenced, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { ChildEnvironment } from '@ferretry/core-vault/contract';
import { bunSpawn, childEnvironments } from '@ferretry/kernel/host';
import should from 'should';
import { TmuxJobRuntime } from '../../../../daemon/adapters/jobs/tmux-job-runtime.ts';
import { TmuxTerminalRuntime } from '../../../../daemon/adapters/terminal/tmux-terminal-runtime.ts';
import { KernelTmuxProcess } from '../../../../daemon/adapters/tmux/kernel-tmux-process.ts';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { CgroupLaunchPlanner, EnforcementRuntime } from '../../../../daemon/lib/cgroups/index.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * EVERY limited new-session path (an agent terminal, an agent job, the ferret's own runner) starts the scope wrapper
 * with the daemon's own user-manager names, whatever the tmux server holds and whatever a caller's environment says.
 *
 * The tmux server here is one an OLDER build started: a client with PATH only, holding another session so it outlives
 * a daemon update. Nothing has launched a ferret since (the runner's `update-environment` edit has not happened), and
 * the callers carry a STALE `DBUS_SESSION_BUS_ADDRESS`. A fake `systemd-run` on PATH records what the wrapper saw, so
 * the proof needs no user manager and no real tmux server of the owner's: the socket is private, in a temp directory.
 */
const TMUX = Bun.which('tmux');
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const AUTHORITATIVE = Object.freeze({
  XDG_RUNTIME_DIR: '/fixture/run/user/4242',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/run/user/4242/bus',
});
const STALE_DBUS = 'unix:path=/stale/gone/bus';
const SAW_AUTHORITATIVE = `${AUTHORITATIVE.XDG_RUNTIME_DIR}|${AUTHORITATIVE.DBUS_SESSION_BUS_ADDRESS}\n`;

async function world() {
  if (TMUX === null) throw new Error('tmux is required for this test and was not found');
  const root = await mkdtemp(join(tmpdir(), 'fy-limited-env-'));
  const bin = join(root, 'bin');
  const saw = join(root, 'saw');
  await mkdir(bin);
  await mkdir(saw);
  await writeFile(
    join(bin, 'systemd-run'),
    `#!/bin/sh\nfor a in "$@"; do case "$a" in --unit=*) u="\${a#--unit=}";; esac; done\nprintf '%s|%s\\n' "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" > "${saw}/$u"\n`,
  );
  await chmod(join(bin, 'systemd-run'), 0o755);
  const path = `${bin}:${process.env['PATH'] ?? '/usr/bin:/bin'}`;
  const socket = join(root, 's');
  const handle = Object.freeze({ names: [] }) as unknown as ChildEnvironment;
  const { toolEnv, sealedEnv, managerEnv } = childEnvironments({ ...AUTHORITATIVE, PATH: path });
  // The caller's own environment is stale: a ferret's env carries a dead bus address.
  const spawn = bunSpawn(
    { PATH: path, HOME: homedir() },
    () => ({
      open: env => (env === handle ? { DBUS_SESSION_BUS_ADDRESS: STALE_DBUS } : undefined),
      searchPathOf: () => undefined,
    }),
    toolEnv,
    sealedEnv,
    managerEnv,
  );
  const tmux = new KernelTmuxProcess(spawn, socket, TMUX);
  cleanups.push(async () => {
    await tmux.execute(['kill-server']);
    await rm(root, { recursive: true, force: true });
  });
  // The server an older build started: PATH alone, and another session that keeps it alive.
  const older = new KernelTmuxProcess(bunSpawn({ PATH: path }), socket, TMUX);
  should((await older.execute(['new-session', '-d', '-s', 'keep', 'sleep', '600'])).code).equal(0);
  should((await older.execute(['show-environment', '-g'])).stdout).not.containEql('XDG_RUNTIME_DIR=');
  const planner = new CgroupLaunchPlanner({
    limits: async () => ({}),
    host: {
      platform: 'linux',
      unifiedHierarchy: true,
      cpus: 8,
      physicalBytes: 16 * 2 ** 30,
      memoryCeilingBytes: 16 * 2 ** 30,
      ceilingSource: 'physical memory',
      swapBytes: 0,
    },
    commands: { execute: async () => ({ code: 0, stdout: '', stderr: '' }) },
    sessions: { facts: async () => ({}) },
    enforcement: new EnforcementRuntime(
      async () => ({ kind: 'cgroups', ionice: false }),
      () => 1,
    ),
    nonce: () => 'n1',
    managerEnvironment: () => AUTHORITATIVE,
  });
  /** What the wrapper of the unit `unit` saw, once it ran. */
  const seen = async (unit: string) => {
    await waitFor(async () => (await readFile(join(saw, unit), 'utf8').catch(() => '')).endsWith('\n'), unit);
    return await readFile(join(saw, unit), 'utf8');
  };
  return { root, socket, handle, spawn, tmux, planner, seen };
}

describe('every limited launch starts the scope wrapper with the daemon’s manager names', () => {
  it.skipIf(process.platform !== 'linux')('should do so for an agent terminal on an older server', async () => {
    // Arrange — the terminal's own configured environment also carries the stale bus address
    const { tmux, planner, seen } = await world();
    const runtime = new TmuxTerminalRuntime(
      tmux,
      () => 1_000,
      { shell: async () => '/bin/sh' },
      planner,
      () => ({
        DBUS_SESSION_BUS_ADDRESS: STALE_DBUS,
      }),
    );

    // Act
    await runtime.create({
      ownerId: 'ses-t',
      id: '0123456789ab',
      title: 'Terminal 1',
      cwd: '/tmp',
      size: { cols: 100, rows: 30 },
      openedBy: { by: 'agent', sessionId: 'ses-t' },
    });

    // Assert
    should(await seen('ferretry-agent-ses-t-tn1.scope')).equal(SAW_AUTHORITATIVE);
  });

  it.skipIf(process.platform !== 'linux')('should do so for an agent job on an older server', async () => {
    // Arrange
    const { tmux, planner, seen } = await world();
    const runtime = new TmuxJobRuntime(tmux, { shell: async () => '/bin/sh' }, planner, () => ({
      DBUS_SESSION_BUS_ADDRESS: STALE_DBUS,
    }));

    // Act
    await runtime.start({
      owner: 'ses-j',
      id: '0123456789ab',
      dir: '/tmp',
      cwd: '/tmp',
      command: 'true',
      limited: true,
    });

    // Assert
    should(await seen('ferretry-agent-ses-j-tn1.scope')).equal(SAW_AUTHORITATIVE);
  });

  it.skipIf(process.platform !== 'linux')(
    'should do so for a ferret launched by the runner, over a stale caller value',
    async () => {
      // Arrange
      const { root, socket, handle, spawn, tmux, planner, seen } = await world();
      const runner = new TmuxRunner({
        tmux,
        spawn,
        socketPath: socket,
        instantOf: () => 'then' as never,
        now: () => 'now' as never,
      });

      // Act
      const started = await runner.start({
        ferret: ferretId('f-runner'),
        command: [...(await planner.command('f-runner', ['sh', '-c', 'true']))],
        cwd: fenced(root),
        env: handle,
      });

      // Assert
      should(started.ok).equal(true);
      should(await seen('ferretry-agent-f-runner-n1.scope')).equal(SAW_AUTHORITATIVE);
    },
  );
});
