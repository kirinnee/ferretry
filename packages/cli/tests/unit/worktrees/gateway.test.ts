import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import {
  ProtocolWorktreeGateway,
  WORKTREE_REMOVE_PATH,
  WORKTREES_PATH,
  worktreeRemovalCheckPath,
} from '../../../src/lib/worktrees/gateway';
import type { WorktreeApiClient } from '../../../src/lib/worktrees/ports';
import { decision, listResponse, removed, WORKTREE_PATH } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

function fakeClient(payload: unknown, calls: Call[] = []): WorktreeApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

describe('worktree routes', () => {
  it('should carry the path as a query parameter, because a checkout path contains slashes', () => {
    // Act + Assert
    should(worktreeRemovalCheckPath(WORKTREE_PATH)).equal('/v1/worktrees/removal?path=%2Fmanaged%2Fferretry-wt-cli6');
  });
});

describe('protocol worktree gateway', () => {
  it('should read the list with a plain GET', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolWorktreeGateway(fakeClient(listResponse(), calls));

    // Act
    const actual = await gateway.list();

    // Assert
    should(calls[0]).match({ path: WORKTREES_PATH, init: undefined });
    should(actual.worktrees).have.length(1);
  });

  it('should default an absent sharedWith to an empty list rather than undefined', async () => {
    // Arrange — the daemon may omit the field entirely
    const payload = {
      worktrees: [
        {
          path: WORKTREE_PATH,
          branch: 'main',
          repositoryRoot: '/repos/ferretry',
          createdAt: '2026-07-31T09:00:00.000Z',
          initialHead: 'a'.repeat(40),
          branchPreexisted: false,
          ownerActive: false,
        },
      ],
    };
    const gateway = new ProtocolWorktreeGateway(fakeClient(payload));

    // Act
    const actual = await gateway.list();

    // Assert
    should(actual.worktrees[0]?.sharedWith).eql([]);
  });

  it('should read a removal verdict with a plain GET', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolWorktreeGateway(fakeClient(decision(), calls));

    // Act
    const actual = await gateway.check(WORKTREE_PATH);

    // Assert
    should(calls[0]?.path).equal(worktreeRemovalCheckPath(WORKTREE_PATH));
    should(actual.removable).be.true();
  });

  it('should post a removal as validated JSON', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolWorktreeGateway(fakeClient(removed(), calls));

    // Act
    const actual = await gateway.remove({
      path: WORKTREE_PATH,
      overrides: ['discard_worktree_changes'],
      deleteBranch: true,
      confirmations: ['delete_unmerged_branch'],
    });

    // Assert
    should(calls[0]?.path).equal(WORKTREE_REMOVE_PATH);
    should(calls[0]?.init?.method).equal('POST');
    should(JSON.parse(String(calls[0]?.init?.body))).eql({
      path: WORKTREE_PATH,
      overrides: ['discard_worktree_changes'],
      deleteBranch: true,
      confirmations: ['delete_unmerged_branch'],
    });
    should(actual.path).equal(WORKTREE_PATH);
  });

  it('should refuse an override the wire contract does not define', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolWorktreeGateway(fakeClient(removed(), calls));

    // Act + Assert
    await should(
      gateway.remove({
        path: WORKTREE_PATH,
        overrides: ['force_everything' as never],
        deleteBranch: false,
        confirmations: [],
      }),
    ).be.rejected();
    should(calls).be.empty();
  });

  it('should fail loudly when the daemon answers with an error envelope', async () => {
    // Arrange
    const gateway = new ProtocolWorktreeGateway(fakeClient({ error: 'no managed root configured' }));

    // Act + Assert
    await should(gateway.list()).be.rejected();
  });
});
