import { afterAll, expect, test } from 'bun:test';
import { cp, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { WorktreesFile } from '../../../../contract/index.ts';
import { buildWorktrees } from '../../../../daemon/modules/worktrees.ts';
import { quarantinePath } from '../../../../daemon/adapters/worktrees/quarantine.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories, setupGit } from '../support/repository.ts';

afterAll(cleanupTempDirectories);

async function fixture(adopted: boolean) {
  const world = await worktreeRouteWorld(`quarantine-${adopted}`);
  let target: string;
  if (adopted) {
    target = path.join(world.repository.root, 'hand-made');
    await setupGit(world.repository.root, 'worktree', 'add', '-b', 'adopt/me', target);
    expect((await world.call('POST /v1/worktrees/adopt', { body: { path: target } })).status).toBe(200);
  } else {
    const created = await world.call('POST /v1/worktrees', {
      body: { sourcePath: world.repository.root, branch: 'managed/remove', sessionId: 'session-1' },
    });
    expect(created.status).toBe(200);
    target = JSON.parse(world.state.raw(WorktreesFile)!).worktrees[0].path;
  }
  const record = () => JSON.parse(world.state.raw(WorktreesFile)!).worktrees[0];
  const remove = async () =>
    await world.call('POST /v1/worktrees/remove', {
      body: { path: target, overrides: ['accept_unpushed_commits'], deleteBranch: false, confirmations: [] },
    });
  const restart = () =>
    buildWorktrees({
      state: world.state.port([WorktreesFile]),
      clock: world.clock,
      io: world.io,
      sessions: async () => [],
      terminalRoots: async () => [],
      stateHomeHolding: async () => undefined,
      newId: () => 'next-owner-token',
    }).service;
  return { ...world, target, record, remove, restart };
}

for (const adopted of [false, true]) {
  test(`Git receives only metadata prune and a replacement survives (${adopted ? 'adopted' : 'managed'})`, async () => {
    const f = await fixture(adopted);
    const run = f.io.git.runBytes;
    let pruned = false;
    f.io.git.runBytes = async (program, args, options) => {
      if (args.includes('worktree') && args.includes('remove')) throw new Error('unsafe Git pathname deletion reached');
      if (args.includes('worktree') && args.includes('prune')) {
        expect(typeof options.cwd).toBe('object');
        expect(args).toContain('--git-dir=.');
        expect(await f.io.fileSystem.type(f.target)).toBe('missing');
        await mkdir(f.target);
        await Bun.write(path.join(f.target, 'keep'), 'replacement');
        pruned = true;
      }
      return await run(program, args, options);
    };
    expect((await f.remove()).status).toBe(200);
    expect(pruned).toBe(true);
    expect(await Bun.file(path.join(f.target, 'keep')).text()).toBe('replacement');
    expect(await f.io.fileSystem.type(quarantinePath(f.record()))).toBe('missing');
  });

  test(`restart finishes only the durably recorded quarantine (${adopted ? 'adopted' : 'managed'})`, async () => {
    const f = await fixture(adopted);
    const removeTree = f.io.fileSystem.removeTree;
    f.io.fileSystem.removeTree = async (target, expected) => {
      expect(f.record().removalIdentity.checkout).toBe(expected);
      expect(await f.io.fileSystem.directoryIdentity(target)).toBe(expected);
      throw new Error('synthetic crash after quarantine');
    };
    expect(await f.remove()).toMatchObject({
      status: 409,
      json: { error: expect.stringContaining('synthetic crash') },
    });
    const quarantine = quarantinePath(f.record());
    expect(await f.io.fileSystem.type(quarantine)).toBe('directory');
    expect(f.record().removedAt).toBeUndefined();
    await mkdir(f.target);
    await Bun.write(path.join(f.target, 'keep'), 'replacement');
    f.io.fileSystem.removeTree = removeTree;
    await f.restart().records();
    expect(await f.io.fileSystem.type(quarantine)).toBe('missing');
    expect(f.record().removedAt).toBeString();
    expect(await Bun.file(path.join(f.target, 'keep')).text()).toBe('replacement');
  });
}

for (const replace of ['quarantine', 'repository'] as const) {
  test(`recovery preserves the checkout when the ${replace} identity changed`, async () => {
    const f = await fixture(true);
    const removeTree = f.io.fileSystem.removeTree;
    f.io.fileSystem.removeTree = async () => {
      throw new Error('synthetic crash');
    };
    expect(await f.remove()).toMatchObject({
      status: 409,
      json: { error: expect.stringContaining('synthetic crash') },
    });
    const quarantine = quarantinePath(f.record());
    if (replace === 'quarantine') {
      await rename(quarantine, `${quarantine}-original`);
      await mkdir(quarantine);
      await Bun.write(path.join(quarantine, 'keep'), 'foreign');
    } else {
      const common = f.record().commonDir;
      await rename(common, `${common}-original`);
      await cp(`${common}-original`, common, { recursive: true });
    }
    f.io.fileSystem.removeTree = removeTree;
    await f.restart().records();
    expect(await f.io.fileSystem.type(quarantine)).toBe('directory');
    expect(f.record().removedAt).toBeUndefined();
    expect(f.record().removalStartedAt).toBeString();
    if (replace === 'quarantine') expect(await Bun.file(path.join(quarantine, 'keep')).text()).toBe('foreign');
  });
}
