import { describe, it } from 'bun:test';
import should from 'should';
import {
  CreateWorktreeRequestSchema,
  isPathSafeWorktreeGroup,
  WORKTREE_GROUP_MAX_LENGTH,
} from '../../../contract/worktrees.ts';

/** The group folder rule: one safe path segment, decided the same way at the wire and in the daemon. */

const request = (group?: string) => ({
  sourcePath: '/repos/ferretry',
  branch: 'feat/x',
  ...(group === undefined ? {} : { group }),
});

describe('isPathSafeWorktreeGroup', () => {
  it.each(['ferretry-1a2b3c4d', 'a', 'Proj_1.2', 'x'.repeat(WORKTREE_GROUP_MAX_LENGTH)])(
    'should accept the group %j',
    group => {
      should(isPathSafeWorktreeGroup(group)).be.true();
    },
  );

  it.each([
    ['empty', ''],
    ['the parent folder', '..'],
    ['the current folder', '.'],
    ['a hidden folder', '.hidden'],
    ['a nested path', 'a/b'],
    ['an absolute path', '/etc'],
    ['a parent hop inside', 'a/../b'],
    ['a backslash', 'a\\b'],
    ['a control character', 'a\u0000b'],
    ['a newline', 'a\nb'],
    ['a space', 'a b'],
    ['overlong', 'x'.repeat(WORKTREE_GROUP_MAX_LENGTH + 1)],
  ])('should refuse a group that is %s', (_label, group) => {
    should(isPathSafeWorktreeGroup(group)).be.false();
  });
});

describe('CreateWorktreeRequestSchema group', () => {
  it('should leave the group absent when none was asked for', () => {
    should(CreateWorktreeRequestSchema.parse(request()).group).be.undefined();
  });

  it('should carry a safe group through', () => {
    should(CreateWorktreeRequestSchema.parse(request('ferretry-1a2b3c4d')).group).equal('ferretry-1a2b3c4d');
  });

  it.each(['..', 'a/b', '/abs', '', 'a\u0007b', 'x'.repeat(WORKTREE_GROUP_MAX_LENGTH + 1)])(
    'should refuse the group %j at the wire',
    group => {
      should(CreateWorktreeRequestSchema.safeParse(request(group)).success).be.false();
    },
  );
});
