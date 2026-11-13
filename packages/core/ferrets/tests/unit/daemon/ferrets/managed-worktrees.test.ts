import { describe, expect, test } from 'bun:test';
import type { ManagedWorktreeSummary } from '../../../../contract/index.ts';
import { FakeFerrets } from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

const ROW: ManagedWorktreeSummary = {
  path: '/fy-home-worktrees/repo-feature',
  branch: 'feature',
  repositoryRoot: '/work/repo',
  commonDirectory: '/work/repo/.git',
  relativeCwd: '',
  createdAt: '2026-11-07T09:00:00.000Z',
  initialHead: 'a'.repeat(40),
  branchPreexisted: false,
};

/** The service with only the seam `managedWorktrees` reads; nothing else may be reached. */
const service = (managedWorktrees?: () => Promise<readonly ManagedWorktreeSummary[]>) =>
  new FerretsService(new FerretRegistry([]), new FerretTokenDirectory(), {
    ready: async () => undefined,
    ...(managedWorktrees === undefined ? {} : { managedWorktrees }),
  } as unknown as FerretsPorts);

describe('the managed worktree registry read (additive contract member, lead ruling (B))', () => {
  test('answers the registry rows the worktrees module holds, unchanged', async () => {
    expect(await service(async () => [ROW]).managedWorktrees()).toEqual([ROW]);
  });

  test('with no registry bound, answers no managed worktree', async () => {
    expect(await service().managedWorktrees()).toEqual([]);
  });

  test('the fake answers what a test set, and nothing before', async () => {
    const fake = new FakeFerrets();
    expect(await fake.managedWorktrees()).toEqual([]);
    fake.setManagedWorktrees([ROW]);
    expect(await fake.managedWorktrees()).toEqual([ROW]);
  });
});
