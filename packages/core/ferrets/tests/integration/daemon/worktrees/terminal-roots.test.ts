import { afterAll, describe, expect, test } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TerminalRootsSource } from '../../../../contract/index.ts';
import { liveTerminalRoots } from '../../../../daemon/lib/worktrees/terminal-roots.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories } from '../support/repository.ts';

/**
 * G3 U1: a removal is judged on the shells Terminals contributes to `terminal.roots`, over real Git and the real
 * removal policy. Before this, the host answered "could not list terminals" for every removal, so none could succeed.
 */

const exists = async (path: string) =>
  await stat(path).then(
    () => true,
    () => false,
  );
const shells = (...roots: string[]): TerminalRootsSource => ({ roots: async () => roots });
const broken: TerminalRootsSource = {
  roots: async () => {
    throw new Error('tmux would not answer');
  },
};

const blockersOf = (json: unknown) => (json as { blockers: { code: string }[] }).blockers.map(each => each.code);

describe('worktree removal over the contributed terminal roots', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  test('G3-U1 no plugin runs shells: no undetermined blocker, and the removal goes through', async () => {
    const world = await worktreeRouteWorld('g3u1-none', () => liveTerminalRoots([]));
    const made = await world.call('POST /v1/worktrees', {
      body: { sourcePath: world.repository.root, branch: 'feat/clean', sessionId: 'ses-1' },
    });
    const path = (made.json as { worktree: { path: string } }).worktree.path;
    const verdict = await world.call('GET /v1/worktrees/removal', { query: { path } });
    expect(blockersOf(verdict.json)).toEqual(['unpushed_commits']);
    const removed = await world.call('POST /v1/worktrees/remove', {
      body: { path, overrides: ['accept_unpushed_commits'], deleteBranch: false, confirmations: [] },
    });
    expect(removed.status).toBe(200);
    expect(await exists(path)).toBe(false);
  });

  test('G3-U1 a contributed shell inside the checkout blocks the removal; one elsewhere does not', async () => {
    let inside = true;
    let path = '';
    const world = await worktreeRouteWorld('g3u1-shell', () =>
      liveTerminalRoots([shells(inside ? `${path}/src` : '/somewhere/else')]),
    );
    const made = await world.call('POST /v1/worktrees', {
      body: { sourcePath: world.repository.root, branch: 'feat/shell', sessionId: 'ses-1' },
    });
    path = (made.json as { worktree: { path: string } }).worktree.path;
    expect(blockersOf((await world.call('GET /v1/worktrees/removal', { query: { path } })).json)).toContain(
      'live_terminal',
    );
    const refused = await world.call('POST /v1/worktrees/remove', {
      body: { path, overrides: ['accept_unpushed_commits'], deleteBranch: false, confirmations: [] },
    });
    expect(refused.status).toBe(409);
    expect(await exists(path)).toBe(true);
    inside = false;
    expect(blockersOf((await world.call('GET /v1/worktrees/removal', { query: { path } })).json)).not.toContain(
      'live_terminal',
    );
  });

  test('G3-U1 shells that could not be listed are unknown, not none: the removal is refused', async () => {
    const world = await worktreeRouteWorld('g3u1-broken', () => liveTerminalRoots([shells('/x'), broken]));
    const made = await world.call('POST /v1/worktrees', {
      body: { sourcePath: world.repository.root, branch: 'feat/unknown', sessionId: 'ses-1' },
    });
    const path = (made.json as { worktree: { path: string } }).worktree.path;
    expect(blockersOf((await world.call('GET /v1/worktrees/removal', { query: { path } })).json)).toContain(
      'undetermined_evidence',
    );
    const refused = await world.call('POST /v1/worktrees/remove', {
      body: { path, overrides: ['accept_unpushed_commits'], deleteBranch: false, confirmations: [] },
    });
    expect(refused.status).toBe(409);
    expect(await exists(path)).toBe(true);
  });

  test('G3-U1 the roots of every contributor are joined', async () => {
    expect(await liveTerminalRoots([shells('/a'), shells('/b', '/c')])).toEqual(['/a', '/b', '/c']);
    expect(await liveTerminalRoots([])).toEqual([]);
  });

  test('G3-U1 a real terminal opened during pinning after the final Git preflight refuses removal', async () => {
    let roots: string[] = [];
    const world = await worktreeRouteWorld('g3u1-late', async () => roots);
    const made = await world.call('POST /v1/worktrees', {
      body: { sourcePath: world.repository.root, branch: 'feat/late', sessionId: 'ses-1' },
    });
    const path = (made.json as { worktree: { path: string } }).worktree.path;
    const socket = join(world.parent, 'private.sock');
    const tmux = async (...args: string[]) => {
      const child = Bun.spawn(['tmux', '-S', socket, ...args], {
        env: { PATH: process.env.PATH ?? '', HOME: world.parent },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(stderr);
      return stdout;
    };
    const pin = world.io.pinner.pin.bind(world.io.pinner);
    let opened = false;
    world.io.pinner.pin = async target => {
      const held = await pin(target);
      if (target === path && !opened) {
        opened = true;
        await tmux('new-session', '-d', '-s', 'late-probe', '-c', path, '/bin/sh');
        roots = [(await tmux('display-message', '-p', '-t', 'late-probe', '#{pane_current_path}')).trim()];
      }
      return held;
    };
    try {
      const removed = await world.call('POST /v1/worktrees/remove', {
        body: { path, overrides: ['accept_unpushed_commits'], deleteBranch: false, confirmations: [] },
      });
      expect(removed.status).toBe(409);
      expect(opened).toBe(true);
      expect(await exists(path)).toBe(true);
    } finally {
      if (opened) await tmux('kill-server');
    }
  });
});
