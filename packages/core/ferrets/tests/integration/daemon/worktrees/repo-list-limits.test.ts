import { afterAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import type { RepoWorktreeListResponse } from '../../../../contract/index.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories, stubGitDirectory } from '../support/repository.ts';

async function until(test: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await test()) return;
    await Bun.sleep(5);
  }
  throw new Error('the fake Git process did not reach the expected state');
}

async function fakeGit(mode: 'row-timeout' | 'list-timeout' | 'flood') {
  const world = await worktreeRouteWorld(`repo-list-${mode}`);
  const marker = path.join(world.repository.root, 'fake-git-pid');
  const realGit = Bun.which('git');
  if (realGit === null) throw new Error('Git is required for the synthetic fixture');
  const command = mode === 'row-timeout' ? 'status --porcelain=v2' : 'worktree list';
  const body = mode === 'flood' ? 'while :; do printf "%4096s" x; done' : 'trap "" TERM; while :; do :; done';
  const directory = await stubGitDirectory(`#!/bin/sh
case "$*" in
  *'${command}'*) printf '%s\\n' "$$" >> '${marker}'; ${body} ;;
esac
exec '${realGit}' "$@"
`);
  const runBytes = world.io.git.runBytes;
  world.io.git.runBytes = async (program, args, options) =>
    await runBytes(program, args, {
      ...options,
      env: { ...options.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
    });
  const call = async () =>
    await world.call('GET /v1/worktrees/repo', {
      query: { commonDir: path.join(world.repository.root, '.git') },
    });
  const dead = async () => {
    const pids = (await Bun.file(marker).text()).trim().split('\n').map(Number);
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    return true;
  };
  return { ...world, marker, call, dead };
}

describe('repository listing process and time bounds', () => {
  afterAll(cleanupTempDirectories);

  it('should kill a hung row child on the row deadline and cancel all pending timers', async () => {
    const world = await fakeGit('row-timeout');
    const before = [...world.state.files];
    const pending = world.call();
    await until(async () => await Bun.file(world.marker).exists());
    await world.clock.advance(15_000);
    const answer = await pending;
    expect(answer.status).toBe(200);
    const row = (answer.json as RepoWorktreeListResponse).worktrees[0];
    expect(row?.live.status).toBeUndefined();
    expect(row?.live.undetermined.join(' ')).toContain('did not answer within');
    await until(world.dead);
    expect(world.clock.pending()).toBe(0);
    expect([...world.state.files]).toEqual(before);
  });

  it('should include initial Git evidence in the overall deadline and kill its child', async () => {
    const world = await fakeGit('list-timeout');
    const pending = world.call();
    await until(async () => await Bun.file(world.marker).exists());
    await world.clock.advance(60_000);
    const answer = await pending;
    expect(answer.status).toBe(500);
    await until(world.dead);
    expect(world.clock.pending()).toBe(0);
    expect(world.state.files.size).toBe(0);
  });

  it('should retain Git rows when the overall budget expires during inspection', async () => {
    const world = await fakeGit('row-timeout');
    const runBytes = world.io.git.runBytes;
    let initial = true;
    world.io.git.runBytes = async (program, args, options) => {
      const result = await runBytes(program, args, options);
      if (initial && args.includes('worktree') && args.includes('list')) {
        initial = false;
        await world.clock.advance(50_000);
      }
      return result;
    };
    const pending = world.call();
    await until(async () => await Bun.file(world.marker).exists());
    await world.clock.advance(10_000);
    const answer = await pending;
    expect(answer.status).toBe(200);
    const row = (answer.json as RepoWorktreeListResponse).worktrees[0];
    expect(row?.live.head).toBe(world.repository.head);
    expect(row?.live.undetermined.length).toBeGreaterThan(0);
    await until(world.dead);
    expect(world.clock.pending()).toBe(0);
  });

  it('should kill a flooding Git child at the output cap and release its streams without waiting for a deadline', async () => {
    const world = await fakeGit('flood');
    const answer = await world.call();
    expect(answer.status).toBe(500);
    await until(world.dead);
    expect(world.clock.pending()).toBe(0);
    expect(world.state.files.size).toBe(0);
  });
});
