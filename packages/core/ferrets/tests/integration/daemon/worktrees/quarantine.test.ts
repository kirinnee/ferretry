import { afterAll, expect, test } from 'bun:test';
import { cp, mkdir, rename, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { WorktreesFile } from '../../../../contract/index.ts';
import { buildWorktrees } from '../../../../daemon/modules/worktrees.ts';
import {
  quarantinePath,
  removalIdentity,
  verifyRemovalMetadata,
} from '../../../../daemon/adapters/worktrees/quarantine.ts';
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
  for (const recovering of [false, true]) {
    test(`metadata cleanup resumes after losing its backlink (${adopted ? 'adopted' : 'managed'}, ${recovering ? 'recovery' : 'live'})`, async () => {
      const f = await fixture(adopted);
      const removeTree = f.io.fileSystem.removeTree;
      if (recovering) {
        f.io.fileSystem.removeTree = async () => {
          throw new Error('synthetic checkout crash');
        };
        expect((await f.remove()).status).toBe(409);
      }
      f.io.fileSystem.removeTree = async (target, expected, beforeDelete) => {
        if (target === f.record().gitDir) {
          await unlink(path.join(target, 'gitdir'));
          await Bun.write(path.join(target, 'locked'), 'synthetic late lock');
          throw new Error('synthetic metadata interruption');
        }
        return await removeTree(target, expected, beforeDelete);
      };
      if (recovering) await f.restart().records();
      else expect((await f.remove()).status).toBe(409);
      expect(f.record().removalIdentity.metadataCleanupStarted).toBe(true);
      expect(f.record().removalIdentity.checkoutRemoved).toBe(true);
      expect(f.record().removedAt).toBeUndefined();
      await unlink(path.join(f.record().gitDir, 'locked'));
      f.io.fileSystem.removeTree = removeTree;
      await f.restart().records();
      expect(f.record().removedAt).toBeString();
      expect(await f.io.fileSystem.type(f.record().gitDir)).toBe('missing');
    });
  }

  test(`removal refuses a symlink and parent traversal in a relative Git backlink (${adopted ? 'adopted' : 'managed'})`, async () => {
    const f = await fixture(adopted);
    const metadata = f.record().gitDir;
    const elsewhere = path.join(f.repository.root, 'elsewhere', 'nested');
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, path.join(metadata, 'detour'));
    const backlink = `detour/../${path.relative(metadata, path.join(f.target, '.git'))}`;
    expect(path.resolve(metadata, backlink)).toBe(path.join(f.target, '.git'));
    await Bun.write(path.join(metadata, 'gitdir'), `${backlink}\n`);
    await expect(
      verifyRemovalMetadata(f.io.fileSystem, f.record(), (await removalIdentity(f.io.fileSystem, f.record()))!),
    ).rejects.toThrow('relative');
    expect((await f.remove()).status).toBe(409);
    expect(await f.io.fileSystem.type(metadata)).toBe('directory');
    expect(await f.io.fileSystem.type(f.target)).toBe('directory');
  });

  test(`recovery keeps metadata when the quarantine was moved without repair (${adopted ? 'adopted' : 'managed'})`, async () => {
    const f = await fixture(adopted);
    const removeTree = f.io.fileSystem.removeTree;
    f.io.fileSystem.removeTree = async () => {
      throw new Error('synthetic crash after rename');
    };
    expect((await f.remove()).status).toBe(409);
    const before = f.record();
    const moved = `${f.target}-moved`;
    await rename(quarantinePath(before), moved);
    f.io.fileSystem.removeTree = removeTree;
    await f.restart().records();
    expect(await f.io.fileSystem.directoryIdentity(before.gitDir)).toBe(before.removalIdentity.gitDirectory);
    expect(f.record()).toEqual(before);
    expect(await Bun.file(path.join(moved, 'README.md')).exists()).toBe(true);
  });

  test(`an already missing quarantine never stamps checkoutRemoved (${adopted ? 'adopted' : 'managed'})`, async () => {
    const f = await fixture(adopted);
    const removeTree = f.io.fileSystem.removeTree;
    f.io.fileSystem.removeTree = async (target, expected, beforeDelete) => {
      if (target === quarantinePath(f.record())) await rename(target, `${f.target}-moved`);
      return await removeTree(target, expected, beforeDelete);
    };
    expect(await f.remove()).toMatchObject({
      status: 409,
      json: { error: expect.stringContaining('git worktree repair') },
    });
    expect(f.record().removalIdentity.checkoutRemoved).toBeUndefined();
    expect(f.record().removalIdentity.metadataCleanupStarted).toBeUndefined();
    expect(f.record().removedAt).toBeUndefined();
    expect(await f.io.fileSystem.type(f.record().gitDir)).toBe('directory');
  });

  test(`a lock arriving during the backlink read prevents rename (${adopted ? 'adopted' : 'managed'})`, async () => {
    const f = await fixture(adopted);
    const readText = f.io.fileSystem.readText;
    let installed = false;
    f.io.fileSystem.readText = async target => {
      const value = await readText(target);
      if (!installed && f.record().removalIdentity !== undefined && target === path.join(f.record().gitDir, 'gitdir')) {
        installed = true;
        await Bun.write(path.join(f.record().gitDir, 'locked'), 'lock during backlink read');
      }
      return value;
    };
    expect((await f.remove()).status).toBe(409);
    expect(installed).toBe(true);
    expect(await f.io.fileSystem.type(f.target)).toBe('directory');
    expect(await f.io.fileSystem.type(quarantinePath(f.record()))).toBe('missing');
  });

  for (const metadata of [false, true]) {
    test(`a lock at the kernel deletion veto keeps ${metadata ? 'metadata' : 'checkout'} (${adopted ? 'adopted' : 'managed'})`, async () => {
      const f = await fixture(adopted);
      const removeTree = f.io.fileSystem.removeTree;
      let installed = false;
      f.io.fileSystem.removeTree = async (target, expected, beforeDelete) => {
        const guarded = metadata ? target === f.record().gitDir : target === quarantinePath(f.record());
        return await removeTree(target, expected, async () => {
          if (guarded && !installed) {
            expect(beforeDelete).toBeFunction();
            installed = true;
            await Bun.write(path.join(f.record().gitDir, 'locked'), 'synthetic lock during kernel preflight');
          }
          await beforeDelete?.();
        });
      };
      expect((await f.remove()).status).toBe(409);
      expect(installed).toBe(true);
      expect(await Bun.file(path.join(f.record().gitDir, 'locked')).text()).toBe(
        'synthetic lock during kernel preflight',
      );
      expect(await Bun.file(path.join(f.record().gitDir, 'gitdir')).exists()).toBe(true);
      expect(f.record().removedAt).toBeUndefined();
      if (!metadata) expect(await Bun.file(path.join(quarantinePath(f.record()), 'README.md')).exists()).toBe(true);
    });
  }

  test(`recovery preserves metadata retargeted by Git worktree move (${adopted ? 'adopted' : 'managed'})`, async () => {
    const f = await fixture(adopted);
    const type = f.io.fileSystem.type;
    const quarantineRename = f.io.fileSystem.quarantineRename;
    let crashed = false;
    f.io.fileSystem.quarantineRename = async () => {
      crashed = true;
      throw new Error('synthetic crash before rename');
    };
    f.io.fileSystem.type = async target => {
      if (crashed) throw new Error('synthetic unavailable recovery');
      return await type(target);
    };
    expect((await f.remove()).status).toBe(409);
    const before = f.record();
    expect(before.removalIdentity).toBeDefined();
    f.io.fileSystem.type = type;
    f.io.fileSystem.quarantineRename = quarantineRename;
    const moved = `${f.target}-moved`;
    await setupGit(f.repository.root, 'worktree', 'move', f.target, moved);
    await f.restart().records();
    expect(await f.io.fileSystem.directoryIdentity(before.gitDir)).toBe(before.removalIdentity.gitDirectory);
    expect(f.record()).toEqual(before);
    expect((await setupGit(moved, 'rev-parse', '--absolute-git-dir')).trim()).toBe(before.gitDir);
  });

  test(`only recorded metadata is deleted and a replacement survives (${adopted ? 'adopted' : 'managed'})`, async () => {
    const f = await fixture(adopted);
    const run = f.io.git.runBytes;
    const removeTree = f.io.fileSystem.removeTree;
    let metadataRemoved = false;
    f.io.git.runBytes = async (program, args, options) => {
      if (args.includes('worktree') && (args.includes('remove') || args.includes('prune')))
        throw new Error('unsafe Git pathname deletion reached');
      return await run(program, args, options);
    };
    f.io.fileSystem.removeTree = async (target, expected) => {
      const entry = f.record();
      if (target === entry.gitDir) {
        expect(expected).toBe(entry.removalIdentity.gitDirectory);
        expect(await f.io.fileSystem.type(f.target)).toBe('missing');
        await mkdir(f.target);
        await Bun.write(path.join(f.target, 'keep'), 'replacement');
        metadataRemoved = true;
      }
      return await removeTree(target, expected);
    };
    expect((await f.remove()).status).toBe(200);
    expect(metadataRemoved).toBe(true);
    expect(await Bun.file(path.join(f.target, 'keep')).text()).toBe('replacement');
    expect(await f.io.fileSystem.type(f.record().gitDir)).toBe('missing');
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

test('removal preserves an unrelated stale Git metadata entry', async () => {
  const f = await fixture(false);
  const other = path.join(f.repository.root, 'unrelated');
  await setupGit(f.repository.root, 'worktree', 'add', '-b', 'unrelated/keep', other);
  const metadata = (await setupGit(other, 'rev-parse', '--absolute-git-dir')).trim();
  await rename(other, `${other}-moved`);
  const identity = await f.io.fileSystem.directoryIdentity(metadata);
  expect((await f.remove()).status).toBe(200);
  expect(await f.io.fileSystem.directoryIdentity(metadata)).toBe(identity);
  expect(await f.io.fileSystem.type(f.record().gitDir)).toBe('missing');
});

test('a replaced metadata directory is preserved after checkout deletion', async () => {
  const f = await fixture(false);
  const removeTree = f.io.fileSystem.removeTree;
  f.io.fileSystem.removeTree = async (target, expected) => {
    const result = await removeTree(target, expected);
    if (target !== quarantinePath(f.record())) return result;
    const metadata = f.record().gitDir;
    await rename(metadata, `${metadata}-original`);
    await cp(`${metadata}-original`, metadata, { recursive: true });
    await Bun.write(path.join(metadata, 'keep'), 'foreign metadata');
    return result;
  };
  expect((await f.remove()).status).toBe(409);
  expect(await Bun.file(path.join(f.record().gitDir, 'keep')).text()).toBe('foreign metadata');
  expect(f.record().removedAt).toBeUndefined();
  expect(f.record().removalStartedAt).toBeString();
});

test('a second removal cannot replace an unresolved identity journal', async () => {
  const f = await fixture(false);
  const removeTree = f.io.fileSystem.removeTree;
  f.io.fileSystem.removeTree = async () => {
    throw new Error('synthetic crash');
  };
  expect((await f.remove()).status).toBe(409);
  const before = f.record();
  const quarantine = quarantinePath(before);
  await cp(quarantine, f.target, { recursive: true });
  await rename(quarantine, `${quarantine}-original`);
  await mkdir(quarantine);
  await Bun.write(path.join(quarantine, 'keep'), 'foreign quarantine');
  f.io.fileSystem.removeTree = removeTree;
  expect((await f.remove()).status).toBe(409);
  expect(f.record()).toEqual(before);
  expect(await Bun.file(path.join(quarantine, 'keep')).text()).toBe('foreign quarantine');
  expect(await f.io.fileSystem.type(f.target)).toBe('directory');
});

for (const adopted of [false, true]) {
  test(`recovery keeps a quarantine when its metadata is missing (${adopted ? 'adopted' : 'managed'})`, async () => {
    const f = await fixture(adopted);
    const removeTree = f.io.fileSystem.removeTree;
    f.io.fileSystem.removeTree = async () => {
      throw new Error('synthetic crash');
    };
    expect((await f.remove()).status).toBe(409);
    const before = f.record();
    const quarantine = quarantinePath(before);
    await rename(before.gitDir, `${before.gitDir}-original`);
    f.io.fileSystem.removeTree = removeTree;
    await f.restart().records();
    expect(await f.io.fileSystem.type(quarantine)).toBe('directory');
    expect(f.record()).toEqual(before);
  });

  for (const boundary of ['quarantine', 'delete'] as const) {
    test(`a late lock preserves the checkout before ${boundary} (${adopted ? 'adopted' : 'managed'})`, async () => {
      const f = await fixture(adopted);
      const quarantineRename = f.io.fileSystem.quarantineRename;
      if (boundary === 'delete') {
        f.io.fileSystem.quarantineRename = async (...args) => {
          await quarantineRename(...args);
          await Bun.write(path.join(f.record().gitDir, 'locked'), 'synthetic late lock');
        };
      } else {
        const type = f.io.fileSystem.type;
        let installed = false;
        // The durable identity is recorded after the final Git/status checks.
        const statePort = f.state.port([WorktreesFile]);
        const update = statePort.update;
        statePort.update = async (...args) => {
          const result = await update(...args);
          if (!installed && f.record().removalIdentity !== undefined) {
            installed = true;
            await Bun.write(path.join(f.record().gitDir, 'locked'), 'synthetic late lock');
          }
          return result;
        };
        // A lifecycle rebuilt on this port exercises the durable-write boundary.
        const service = buildWorktrees({
          state: statePort,
          clock: f.clock,
          io: f.io,
          sessions: async () => [],
          terminalRoots: async () => [],
          stateHomeHolding: async () => undefined,
          newId: () => 'next-owner-token',
        }).service;
        await expect(
          service.remove({
            path: f.target,
            overrides: ['accept_unpushed_commits'],
            deleteBranch: false,
            confirmations: [],
          }),
        ).rejects.toThrow();
        expect(installed).toBe(true);
        expect(await type(f.target)).toBe('directory');
        return;
      }
      expect((await f.remove()).status).toBe(409);
      const quarantine = quarantinePath(f.record());
      expect(await f.io.fileSystem.type(quarantine)).toBe('directory');
      expect(f.record().removalStartedAt).toBeString();
      await f.restart().records();
      expect(await f.io.fileSystem.type(quarantine)).toBe('directory');
      expect(f.record().removedAt).toBeUndefined();
    });
  }
}
