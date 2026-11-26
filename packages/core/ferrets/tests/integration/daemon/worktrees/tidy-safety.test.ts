import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { cp, rename } from 'node:fs/promises';
import * as contract from '@ferretry/core-ferrets/contract';
import type { WorktreeRemovalRequest } from '@ferretry/core-ferrets/contract';
import * as worktreeFeature from '../../../../daemon/features/worktrees.feature.ts';
import { worktreeRouteWorld } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories, setupGit, tempRemote } from '../support/repository.ts';

// All repositories, remotes, roots and state are synthetic. The real lifecycle and U3 Git runner do the work.
async function fixture(label: string) {
  const w = await worktreeRouteWorld(`tidy-${label}`);
  await tempRemote(w.repository.root, 'origin', 'main');
  await setupGit(w.repository.root, 'remote', 'set-head', 'origin', 'main');
  const created = await w.built.service.create({
    sourcePath: w.repository.root,
    branch: 'feature',
    base: { kind: 'head' },
  });
  const target = created.worktree.path;
  await setupGit(target, 'commit', '--allow-empty', '-m', 'feat: merged feature');
  await setupGit(target, 'push', '-u', 'origin', 'feature');
  const head = (await setupGit(target, 'rev-parse', 'HEAD')).trim();
  const decision = await w.built.service.checkRemoval(target, undefined, true);
  const request: WorktreeRemovalRequest = {
    path: target,
    expectedHead: head,
    expectedIdentity: decision.reviewedIdentity,
    overrides: [],
    deleteBranch: true,
    confirmations: ['delete_unmerged_branch'],
  };
  return { ...w, target, request };
}

afterAll(cleanupTempDirectories);

describe('Tidy data-loss regressions', () => {
  test('MUST 1: the plugin removal contract requires a head and identity and accepts no loss flags', () => {
    const removeWorktree = async () => ({
      path: '/synthetic',
      branch: 'feature',
      branchRetained: true,
      branchBlockers: [],
      removedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(worktreeFeature.worktreePortFor).toBeDefined();
    expect(worktreeFeature.worktreePortFor('tidy', { removeWorktree }).removeWorktree).toBe(removeWorktree);
    for (const needer of ['projects', 'pulls', 'arbitrary'])
      expect('removeWorktree' in worktreeFeature.worktreePortFor(needer, { removeWorktree })).toBe(false);
    const schema = contract.GuardedWorktreeRemovalRequestSchema;
    expect(schema).toBeDefined();
    const safe = {
      path: '/synthetic/tree',
      expectedHead: 'a'.repeat(40),
      expectedIdentity: {
        recordId: 'registry-row',
        branchRef: 'refs/heads/feature',
        checkout: '1:2',
        head: 'a'.repeat(40),
      },
    };
    expect(schema.safeParse(safe).success).toBe(true);
    for (const field of ['expectedHead', 'expectedIdentity']) {
      const invalid = { ...safe };
      delete invalid[field as keyof typeof safe];
      expect(schema.safeParse(invalid).success).toBe(false);
    }
    for (const [field, value] of [
      ['overrides', []],
      ['confirmations', []],
      ['deleteBranch', true],
    ] as const)
      expect(schema.safeParse({ ...safe, [field]: value }).success).toBe(false);
  });

  test('MUST 2: an unrelated managed branch at the same SHA cannot inherit a reviewed identity', async () => {
    const w = await fixture('same-sha');
    const other = await w.built.service.create({
      sourcePath: w.repository.root,
      branch: 'unrelated',
      base: { kind: 'commit', reference: w.request.expectedHead! },
    });
    const result = await w.built.service.remove({ ...w.request, path: other.worktree.path }).catch(error => error);
    expect(result.code).toBe('unsafe_remove');
    expect(await Bun.file(path.join(other.worktree.path, '.git')).exists()).toBe(true);
  });

  test('MUST 3: advancing the ref after checkout removal retains the unpushed commit', async () => {
    const w = await fixture('advanced-ref');
    const newer = (
      await setupGit(w.repository.root, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'unpushed work')
    ).trim();
    const spawn = w.io.git.runBytes;
    w.io.git.runBytes = async (program, args, options) => {
      const result = await spawn(program, args, options);
      if (args.includes('remove') && args.includes('worktree') && result.exitCode === 0)
        await setupGit(w.repository.root, 'update-ref', 'refs/heads/feature', newer);
      return result;
    };
    const result = await w.built.service.remove(w.request);
    expect(result.branchRetained).toBe(true);
    expect(result.branchBlockers.length).toBeGreaterThan(0);
    expect((await setupGit(w.repository.root, 'rev-parse', 'feature')).trim()).toBe(newer);
  });

  test('MUST 2: a new eligible registry record at the reviewed path cannot inherit consent', async () => {
    const w = await fixture('new-record');
    const state = w.state.port([contract.WorktreesFile]);
    await state.update(contract.WorktreesFile, current => ({
      ...current!,
      worktrees: current!.worktrees.map(row => ({ ...row, ownershipToken: 'new-record-token' })),
    }));
    const gitDir = (await setupGit(w.target, 'rev-parse', '--absolute-git-dir')).trim();
    await Bun.write(path.join(gitDir, 'worktree-owner'), 'new-record-token');
    expect((await w.built.service.checkRemoval(w.target, undefined, true)).removable).toBe(true);
    const result = await w.built.service.remove(w.request).catch(error => error);
    expect(result.code).toBe('unsafe_remove');
    expect(await Bun.file(path.join(w.target, '.git')).exists()).toBe(true);
  });

  test('MUST 2: a clean directory replacement with copied metadata cannot inherit consent', async () => {
    const w = await fixture('new-inode');
    await rename(w.target, `${w.target}-original`);
    await cp(`${w.target}-original`, w.target, { recursive: true });
    expect((await w.built.service.checkRemoval(w.target, undefined, true)).removable).toBe(true);
    const result = await w.built.service.remove(w.request).catch(error => error);
    expect(result.code).toBe('unsafe_remove');
    expect(await Bun.file(path.join(w.target, '.git')).exists()).toBe(true);
  });

  test('an incomplete attached-branch read at the mutation boundary keeps the checkout', async () => {
    const w = await fixture('truncated-branch');
    const spawn = w.io.git.runBytes;
    w.io.git.runBytes = async (program, args, options) => {
      const result = await spawn(program, args, options);
      return args.includes('symbolic-ref') && args.at(-1) === 'HEAD' ? { ...result, stdoutTruncated: true } : result;
    };
    await expect(w.built.service.remove(w.request)).rejects.toBeDefined();
    expect(await Bun.file(path.join(w.target, '.git')).exists()).toBe(true);
  });

  for (const change of ['detached', 'ignored'] as const)
    test(`MUST 4: keeps ${change} content introduced at the final head check`, async () => {
      const w = await fixture(change);
      await Bun.write(path.join(w.repository.root, '.git/info/exclude'), 'late-ignored\n');
      const spawn = w.io.git.runBytes;
      let changed = false;
      w.io.git.runBytes = async (program, args, options) => {
        if (!changed && args.includes('rev-parse') && args.includes('--verify') && args.at(-1) === 'HEAD') {
          changed = true;
          if (change === 'detached') await setupGit(w.target, 'checkout', '--detach', w.request.expectedHead!);
          else await Bun.write(path.join(w.target, 'late-ignored'), 'keep my data\n');
        }
        return await spawn(program, args, options);
      };
      const result = await w.built.service.remove(w.request).catch(error => error);
      expect(changed).toBe(true);
      expect(result.code).toBe('unsafe_remove');
      expect(await Bun.file(path.join(w.target, '.git')).exists()).toBe(true);
      if (change === 'ignored')
        expect(await Bun.file(path.join(w.target, 'late-ignored')).text()).toBe('keep my data\n');
    });
});
