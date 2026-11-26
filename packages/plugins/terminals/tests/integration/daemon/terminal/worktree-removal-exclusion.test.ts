import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenced, ferretId, emptyChildEnvironment } from '@ferretry/core-ferrets/contract/testing';
import { ManagedTerminalService } from '../../../../daemon/adapters/terminal/service.ts';
import { TmuxTerminalRuntime } from '../../../../daemon/adapters/terminal/tmux-terminal-runtime.ts';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { WorktreeGuard } from '../../../../daemon/lib/terminal/worktree-guard.ts';
import { BunTmuxProcess, hostSpawn } from '../support/host-spawn.ts';

const cleanups: (() => Promise<void>)[] = [];
const gate = () => {
  let open!: () => void;
  const ready = new Promise<void>(resolve => {
    open = resolve;
  });
  return { ready, open };
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('the shared worktree removal reservation', () => {
  for (const kind of ['terminal', 'start', 'resume'] as const) {
    test('A: refuses ' + kind + ' while deletion holds the checkout, including symlink descendants', async () => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), 'fy-g3-exclusion-')));
      const path = join(parent, 'checkout');
      await mkdir(join(path, 'src'), { recursive: true });
      const alias = join(parent, 'alias');
      await symlink(join(path, 'src'), alias);
      const socket = join(parent, 'private.sock');
      const tmux = new BunTmuxProcess('tmux', socket);
      cleanups.push(async () => {
        await tmux.execute(['kill-server']);
        await rm(parent, { recursive: true, force: true });
      });
      const guard = new WorktreeGuard(realpath);
      const runtime = new TmuxTerminalRuntime(tmux, Date.now, { shell: async () => '/bin/sh' });
      const service = new ManagedTerminalService(
        runtime,
        { resolve: async () => ({ id: 'fixture', cwd: parent }) },
        { now: Date.now },
        { next: () => '0123456789ab' },
        { worktrees: guard, isDirectory: async () => true },
      );
      const runner = new TmuxRunner({
        tmux,
        worktrees: guard,
        socketPath: socket,
        spawn: hostSpawn,
        instantOf: () => '2026-11-16T00:00:00.000Z' as never,
        now: () => '2026-11-16T00:00:00.000Z' as never,
      });
      const spec = {
        cwd: fenced(alias),
        ferret: ferretId('fixture'),
        command: ['/bin/sh'],
        env: emptyChildEnvironment(),
      };
      await guard.withRemoval(path, async () => {
        if (kind === 'terminal') {
          await expect(service.create('fixture', { folder: alias })).rejects.toThrow('being removed');
        } else {
          expect(
            (kind === 'start' ? await runner.start(spec) : await runner.resume(spec, 'fixture-conversation')).ok,
          ).toBe(false);
        }
        expect((await tmux.execute(['list-panes', '-a'])).code).not.toBe(0);
        // A same-prefix sibling is outside the reservation.
        const sibling = path + '-sibling';
        await mkdir(sibling);
        expect(
          await guard.launch(
            sibling,
            () => false,
            async () => true,
          ),
        ).toBe(true);
      });
      expect(
        await guard.launch(
          alias,
          () => false,
          async () => true,
        ),
      ).toBe(true);
    });
  }

  test('A: drains an admitted launch before sampling, refuses newcomers, and releases after a refusal', async () => {
    const guard = new WorktreeGuard(async path => path);
    const started = gate();
    const finish = gate();
    const events: string[] = [];
    const launch = guard.launch(
      '/checkout/src',
      () => false,
      async () => {
        started.open();
        await finish.ready;
        events.push('launched');
        return true;
      },
    );
    await started.ready;
    const removing = guard.withRemoval('/checkout', async () => {
      events.push('sample');
      throw new Error('occupied');
    });
    // The reservation is installed before this later launch is admitted.
    expect(
      await guard.launch(
        '/checkout/src',
        () => false,
        async () => true,
      ),
    ).toBe(false);
    expect(events).toEqual([]);
    finish.open();
    expect(await launch).toBe(true);
    await expect(removing).rejects.toThrow('occupied');
    expect(events).toEqual(['launched', 'sample']);
    expect(
      await guard.launch(
        '/checkout/src',
        () => false,
        async () => true,
      ),
    ).toBe(true);
  });
});
