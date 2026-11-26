import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnPort } from '@ferretry/kernel/contract';
import { ManagedTerminalService } from '../../../../daemon/adapters/terminal/service.ts';
import { TmuxTerminalRuntime } from '../../../../daemon/adapters/terminal/tmux-terminal-runtime.ts';
import { KernelTmuxProcess } from '../../../../daemon/adapters/tmux/kernel-tmux-process.ts';
import { BunTmuxProcess } from '../support/host-spawn.ts';
import { waitForValue } from '../support/wait-for.ts';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const directories: string[] = [];

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'fy-g3-roots-')));
  directories.push(parent);
  const path = join(parent, 'checkout');
  await mkdir(path);
  const socket = join(parent, 'private.sock');
  const tmux = new BunTmuxProcess('tmux', socket);
  const runtime = new TmuxTerminalRuntime(tmux, Date.now, { shell: async () => '/bin/sh' });
  const service = new ManagedTerminalService(
    runtime,
    { resolve: async () => undefined },
    { now: Date.now },
    { next: () => 'x' },
  );
  const open = async (cwd: string) =>
    await runtime.create({
      ownerId: 'F1',
      id: '0123456789ab',
      title: 'probe',
      cwd,
      size: { cols: 80, rows: 24 },
    });
  return { parent, path, socket, tmux, runtime, service, open };
}

describe('G3 U1 destructive occupancy evidence from private tmux', () => {
  afterAll(async () => {
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  });

  test('1a: a shell started outside and cd into checkout/src reports its current directory', async () => {
    const f = await fixture();
    try {
      const src = join(f.path, 'src');
      await mkdir(src);
      const shell = await f.open(f.parent);
      await f.runtime.write(shell, new TextEncoder().encode(`cd ${quote(src)}\r`));
      await waitForValue(async () => {
        const current = await f.tmux.execute([
          'display-message',
          '-p',
          '-t',
          `${shell.tmuxSession}:0.0`,
          '#{pane_current_path}',
        ]);
        return current.stdout.trim() === src ? true : undefined;
      }, 'shell to cd into checkout/src');
      expect(await f.service.roots()).toEqual([await realpath(src)]);
    } finally {
      await f.tmux.execute(['kill-server']);
    }
  });

  test('1b: a shell started through a symlink reports the canonical checkout directory', async () => {
    const f = await fixture();
    try {
      const alias = join(f.parent, 'checkout-link');
      await symlink(f.path, alias);
      await f.open(alias);
      expect(await f.service.roots()).toEqual([await realpath(f.path)]);
    } finally {
      await f.tmux.execute(['kill-server']);
    }
  });

  test('2: moving the private socket while its terminal is live throws, never answers empty', async () => {
    const f = await fixture();
    const moved = `${f.socket}.moved`;
    try {
      await f.open(f.path);
      expect((await f.runtime.list()).length).toBe(1);
      await rename(f.socket, moved);
      await expect(f.service.roots()).rejects.toThrow('could not read live pane directories');
    } finally {
      await new BunTmuxProcess('tmux', moved).execute(['kill-server']);
    }
  });

  test('1c: an unreadable pane cwd throws, never answers empty', async () => {
    for (const cwd of ['\n', '/does-not-exist/g3-synthetic\n']) {
      const runtime = new TmuxTerminalRuntime(
        { execute: async () => ({ code: 0, stdout: cwd, stderr: '' }) },
        Date.now,
        { shell: async () => '/bin/sh' },
      );
      const service = new ManagedTerminalService(
        runtime,
        { resolve: async () => undefined },
        { now: Date.now },
        { next: () => 'x' },
      );
      await expect(service.roots()).rejects.toThrow();
    }
  });

  test('2b: every spawned tmux fallback has a finite kernel timeout', async () => {
    let timeout: unknown;
    const spawn = {
      run: async (_program: string, _args: readonly string[], options?: { timeout?: unknown }) => {
        timeout = options?.timeout;
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    } as unknown as SpawnPort;
    await new KernelTmuxProcess(spawn, '/tmp/synthetic-only.sock').execute(['list-panes', '-a']);
    expect(timeout).toBeDefined();
    expect(Number(timeout)).toBeGreaterThan(0);
    expect(Number(timeout)).toBeLessThanOrEqual(5_000);
  });
});
