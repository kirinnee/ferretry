import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenced, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { ChildEnvironment } from '@ferretry/core-vault/contract';
import { bunSpawn } from '@ferretry/kernel/host';
import { paneProcessHost } from '../../../../daemon/adapters/tmux/pane-process-host.ts';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { agentScopeCommand, agentScopeName } from '../../../../daemon/lib/cgroups/scope.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';
import { waitFor } from '../support/wait-for.ts';

const placement = process.platform === 'linux' ? await readFile('/proc/self/cgroup', 'utf8') : '';
const ownSlice = placement
  .trim()
  .split('/')
  .findLast(part => part.endsWith('.slice'));

test.skipIf(ownSlice === undefined || !ownSlice.includes('_fleet-'))(
  'MUST 4: stop ends an owned orphan after its pane and session vanished, even across runner restart',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'fx2679-scope-'));
    const socket = join(root, 's');
    const tmux = new BunTmuxProcess('tmux', socket);
    // The machine fence is inherited: the only new scope stays inside THIS test's per-ferret slice.
    const slice = ownSlice;
    if (slice === undefined || !slice.includes('_fleet-'))
      throw new Error('this proof requires an inherited per-ferret fleet slice');
    const scope = agentScopeName(`fx2679-${crypto.randomUUID()}`, 'proof');
    const id = ferretId('owned-scope-proof');
    const environment = Object.freeze({ names: [] }) as unknown as ChildEnvironment;
    const spawn = bunSpawn(process.env as Record<string, string>, () => ({
      open: env =>
        env === environment
          ? {
              PATH: process.env['PATH'] ?? '/usr/bin:/bin',
              HOME: root,
              XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'] ?? '',
              DBUS_SESSION_BUS_ADDRESS: process.env['DBUS_SESSION_BUS_ADDRESS'] ?? '',
            }
          : undefined,
      searchPathOf: () => undefined,
    }));
    const stored = new Map<string, string>();
    const options = {
      tmux,
      spawn,
      socketPath: socket,
      now: () => 'now' as never,
      instantOf: () => 'then' as never,
      processes: paneProcessHost(spawn),
      sleep: async (ms: number) => await Bun.sleep(ms),
      treeEnd: { stepMs: 200, pollMs: 10 },
      scopes: {
        scopeOf: async (ferret: string) => stored.get(ferret),
        recordScope: async (ferret: string, unit: string | undefined) => {
          if (unit === undefined) stored.delete(ferret);
          else stored.set(ferret, unit);
        },
      },
      wrap: async (_ferret: string, command: readonly string[]) =>
        agentScopeCommand({
          scope,
          slice,
          properties: [],
          command,
          environment: {
            XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'] ?? '',
            DBUS_SESSION_BUS_ADDRESS: process.env['DBUS_SESSION_BUS_ADDRESS'] ?? '',
          },
        }),
    };
    try {
      const script = join(root, 'agent.sh');
      await writeFile(
        script,
        `#!/bin/sh\nsh -c 'trap "" HUP INT TERM; exec sleep 300' &\necho $! > '${root}/helper'\nwait\n`,
      );
      const runner = new TmuxRunner(options);
      const started = await runner.start({ ferret: id, command: ['sh', script], cwd: fenced(root), env: environment });
      if (!started.ok) throw new Error(`launch failed: ${started.error}`);
      await waitFor(async () => Number(await readFile(join(root, 'helper'), 'utf8').catch(() => '')) > 1, 'own orphan');
      const helper = Number(await readFile(join(root, 'helper'), 'utf8'));
      expect((await readFile(`/proc/${helper}/cgroup`, 'utf8')).includes(`/${scope}`)).toBe(true);
      await tmux.execute(['kill-session', '-t', '=fy-owned-scope-proof']);
      await waitFor(
        async () => (await tmux.execute(['has-session', '-t', '=fy-owned-scope-proof'])).code !== 0,
        'pane ended independently',
      );
      expect((await readFile(`/proc/${helper}/stat`, 'utf8')).includes('sleep')).toBe(true);
      await new TmuxRunner(options).stop(started.value.handle, 'now', id);
      const stat = await readFile(`/proc/${helper}/stat`, 'utf8').catch(() => '');
      expect(stat === '' || /\) [ZX] /u.test(stat)).toBe(true);
    } finally {
      // Only this random scope and this private socket were created here. Never touch any other unit or tmux server.
      await spawn.run('systemctl', ['--user', 'kill', '--signal=SIGKILL', '--kill-whom=all', scope]);
      await tmux.execute(['kill-server']);
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
