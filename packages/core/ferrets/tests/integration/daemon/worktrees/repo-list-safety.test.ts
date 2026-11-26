import { afterAll, describe, expect, it } from 'bun:test';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { WorktreesFile, type RepoWorktreeListResponse } from '../../../../contract/index.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories, setupGit, tempDirectory } from '../support/repository.ts';

const managed = async (world: Awaited<ReturnType<typeof worktreeRouteWorld>>) => {
  const created = await world.call('POST /v1/worktrees', {
    body: { sourcePath: world.repository.root, branch: 'feature/safety', sessionId: 'session-1' },
  });
  expect(created.status).toBe(200);
  return JSON.parse(world.state.raw(WorktreesFile)!).worktrees[0].path as string;
};

const listing = async (world: Awaited<ReturnType<typeof worktreeRouteWorld>>) => {
  const answer = await world.call('GET /v1/worktrees/repo', {
    query: { commonDir: path.join(world.repository.root, '.git') },
  });
  expect(answer.status).toBe(200);
  return (answer.json as RepoWorktreeListResponse).worktrees;
};

describe('repository worktree read safety', () => {
  afterAll(cleanupTempDirectories);

  it('should bind status to the held checkout despite a redirected core.worktree', async () => {
    const world = await worktreeRouteWorld('repo-list-core-worktree');
    const target = await managed(world);
    const decoy = path.join(world.repository.root, 'decoy');
    await mkdir(decoy);
    await Bun.write(path.join(decoy, 'README.md'), '# fixture\n');
    await Bun.write(path.join(decoy, 'decoy-only.txt'), 'not in the held checkout\n');
    await setupGit(world.repository.root, 'config', 'extensions.worktreeConfig', 'true');
    await setupGit(target, 'config', '--worktree', 'core.worktree', decoy);
    await Bun.write(path.join(target, 'README.md'), 'changed held checkout\n');

    const row = (await listing(world)).find(row => row.path === target);
    expect(row?.tracked).toBe('managed');
    expect(row?.live.status).toMatchObject({ unstaged: true, untracked: false });
  });

  it('should never mark a row managed after a swallowed final identity check failure', async () => {
    const world = await worktreeRouteWorld('repo-list-final-identity');
    const target = await managed(world);
    const checkout = world.io.repoAccess.checkout;
    const runBytes = world.io.git.runBytes;
    let invalid = false;
    let failures = 0;
    world.io.repoAccess.checkout = async (folder, repository) => {
      const held = await checkout(folder, repository);
      if (folder !== target) return held;
      return {
        ...held,
        verify: async () => {
          await held.verify();
          if (invalid) {
            failures++;
            throw new Error('final checkout identity check failed');
          }
        },
      };
    };
    world.io.git.runBytes = async (program, args, options) => {
      const result = await runBytes(program, args, options);
      if (typeof options.cwd === 'object' && options.cwd.describe === target && args.includes('status')) invalid = true;
      return result;
    };

    const row = (await listing(world)).find(row => row.path === target);
    expect(failures).toBeGreaterThan(0);
    expect(row?.tracked).toBe('none');
    expect(row?.live.status).toBeUndefined();
    expect(row?.live.undetermined.join(' ')).toContain('identity check failed');
  });

  it('should never contact a local promisor transport during listing or managed examination', async () => {
    const world = await worktreeRouteWorld('repo-list-promisor');
    await managed(world);
    const root = world.repository.root;
    const transport = await tempDirectory('repo-list-transport');
    const remote = path.join(transport, 'remote.git');
    const marker = path.join(transport, 'contacted');
    const uploadPack = path.join(transport, 'upload-pack');
    await setupGit(root, 'clone', '--bare', '--no-hardlinks', root, remote);
    await Bun.write(uploadPack, `#!/bin/sh\nprintf contacted >> '${marker}'\nexec git-upload-pack "$@"\n`);
    await chmod(uploadPack, 0o700);
    await setupGit(root, 'config', 'core.repositoryformatversion', '1');
    await setupGit(root, 'config', 'extensions.partialClone', 'origin');
    await setupGit(root, 'config', 'remote.origin.url', `file://${remote}`);
    await setupGit(root, 'config', 'remote.origin.promisor', 'true');
    await setupGit(root, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    await setupGit(root, 'config', 'remote.origin.uploadpack', uploadPack);
    const tree = (await setupGit(root, 'rev-parse', 'HEAD^{tree}')).trim();
    await rm(path.join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));

    // Both public read paths must fail closed on missing promised objects, without starting any transport.
    const rows = await listing(world);
    await world.built.service.list();
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(rows.some(row => row.live.undetermined.length > 0)).toBe(true);

    // Positive control: this very repository lazily fetches over file:// with ordinary Git. No network is used.
    await setupGit(root, 'status', '--porcelain=v2');
    expect(await Bun.file(marker).exists()).toBe(true);
  });
});
