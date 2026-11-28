import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { realKernel } from '../support/real-git.ts';

let privateRoot = '';

test('a private worktree parent is removed after the test that allocated it', () => {
  const result = realKernel().roots.root('worktrees').resolve('');
  if (!result.ok) throw new Error('expected a private worktree root');
  privateRoot = result.value;
  expect(privateRoot).toContain('relocate-private-worktrees-');
  expect(existsSync(privateRoot)).toBe(true);
});

test('the next test sees the previous test’s private parent removed', () => {
  expect(privateRoot).not.toBe('');
  expect(existsSync(privateRoot)).toBe(false);
});
