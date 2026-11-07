import { describe, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import should from 'should';
import { ClientWorktreeGateway, WORKTREE_ROUTES } from '../../../../cli/lib/worktrees/gateway.ts';
import { CALLER_CWD, created, decision, listResponse, removed, WORKTREE_PATH } from './fixtures.ts';

interface Call {
  route: string;
  init: Parameters<PluginClient['call']>[1];
}

function fakeClient(payload: unknown, calls: Call[] = []): PluginClient {
  return {
    call: async (route, init) => {
      calls.push({ route, init });
      return payload as never;
    },
    subscribe: () => () => undefined,
  };
}

describe('client worktree gateway', () => {
  it('V-0502 should read the list with a plain GET', async () => {
    const calls: Call[] = [];
    const actual = await new ClientWorktreeGateway(fakeClient(listResponse(), calls)).list();
    should(calls).deepEqual([{ route: WORKTREE_ROUTES.list, init: undefined }]);
    should(actual.worktrees).have.length(1);
  });

  it('should default an absent sharedWith to an empty list rather than undefined', async () => {
    const payload = {
      worktrees: [
        {
          path: WORKTREE_PATH,
          branch: 'main',
          repositoryRoot: '/repos/ferretry',
          commonDirectory: '/repos/ferretry/.git',
          relativeCwd: '',
          createdAt: '2026-07-31T09:00:00.000Z',
          initialHead: 'a'.repeat(40),
          branchPreexisted: false,
          ownerActive: false,
        },
      ],
    };
    const actual = await new ClientWorktreeGateway(fakeClient(payload)).list();
    should(actual.worktrees[0]?.sharedWith).eql([]);
  });

  it('V-0499 should carry the path, and the caller directory beside it, as query parameters', async () => {
    const calls: Call[] = [];
    const gateway = new ClientWorktreeGateway(fakeClient(decision(), calls));
    const actual = await gateway.check(WORKTREE_PATH);
    await gateway.check(WORKTREE_PATH, CALLER_CWD);
    should(calls).deepEqual([
      { route: WORKTREE_ROUTES.check, init: { query: { path: WORKTREE_PATH } } },
      { route: WORKTREE_ROUTES.check, init: { query: { path: WORKTREE_PATH, cwd: CALLER_CWD } } },
    ]);
    should(actual.removable).be.true();
  });

  it('V-0504 should post a removal as validated JSON, and refuse an override the wire does not define', async () => {
    const calls: Call[] = [];
    const gateway = new ClientWorktreeGateway(fakeClient(removed(), calls));
    const request = {
      path: WORKTREE_PATH,
      overrides: ['discard_worktree_changes' as const],
      deleteBranch: true,
      confirmations: ['delete_unmerged_branch' as const],
    };
    const actual = await gateway.remove(request);
    should(calls).deepEqual([{ route: WORKTREE_ROUTES.remove, init: { body: request } }]);
    should(actual.path).equal(WORKTREE_PATH);

    await should(
      gateway.remove({ path: WORKTREE_PATH, overrides: ['force_everything' as never], deleteBranch: false, confirmations: [] }),
    ).be.rejected();
    should(calls).have.length(1);
  });

  it('should fail loudly when the daemon answers something that is not a list', async () => {
    await should(new ClientWorktreeGateway(fakeClient({ error: 'no managed root configured' })).list()).be.rejected();
  });

  it('V-0500 should post a fork as validated JSON, and refuse a base the wire does not define', async () => {
    const calls: Call[] = [];
    const gateway = new ClientWorktreeGateway(fakeClient(created(), calls));
    const actual = await gateway.create({
      sourcePath: '/repos/ferretry',
      branch: 'feat/new',
      base: { kind: 'default-branch' },
    });
    should(calls[0]).deepEqual({
      route: WORKTREE_ROUTES.create,
      init: { body: { sourcePath: '/repos/ferretry', branch: 'feat/new', base: { kind: 'default-branch' } } },
    });
    should(actual.cwd).equal('/managed/ferretry-new/packages/cli');
    await should(
      gateway.create({ sourcePath: '/repos/ferretry', branch: 'feat/new', base: { kind: 'yesterday' } as never }),
    ).be.rejected();
    should(calls).have.length(1);
  });
});
