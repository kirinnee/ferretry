import { expect, test } from 'bun:test';
import type { TerminalRootsSource } from '../../../../contract/index.ts';
import { withTerminalRemoval } from '../../../../daemon/lib/worktrees/terminal-roots.ts';

test('removal holds every terminal contributor until the delete settles', async () => {
  const events: string[] = [];
  const source = (id: string): TerminalRootsSource => ({
    roots: async () => [],
    withRemoval: async (path, work) => {
      events.push(id + ' holds ' + path);
      try {
        return await work();
      } finally {
        events.push(id + ' released');
      }
    },
  });
  expect(await withTerminalRemoval([], '/checkout', async () => 'empty')).toBe('empty');
  await expect(
    withTerminalRemoval([source('a'), source('b')], '/checkout', async () => {
      events.push('delete');
      throw new Error('occupied');
    }),
  ).rejects.toThrow('occupied');
  expect(events).toEqual(['a holds /checkout', 'b holds /checkout', 'delete', 'b released', 'a released']);
});
