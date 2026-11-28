import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { realKernel } from '../support/real-git.ts';

let privateRoot = '';
// The helper's own afterEach runs first. Each test must leave no private git parent behind.
afterEach(() => {
  expect(existsSync(privateRoot)).toBe(false);
});

test('a private worktree parent is removed after the test that allocated it', () => {
  const result = realKernel().roots.root('worktrees').resolve('');
  if (!result.ok) throw new Error('expected a private worktree root');
  privateRoot = result.value;
  expect(privateRoot).toContain('relocate-private-worktrees-');
  expect(existsSync(privateRoot)).toBe(true);
});
