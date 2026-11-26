import { describe, it } from 'bun:test';
import should from 'should';
import { ManagedTerminalService } from '../../../../daemon/adapters/terminal/service.ts';
import type { TerminalRecord, TerminalRuntimePort } from '../../../../daemon/lib/terminal/contracts.ts';

const held = (id: string, root: string): TerminalRecord => ({
  id,
  ownerId: 'F1',
  title: id,
  root,
  tmuxSession: `fy-webterm-F1-${id}`,
  createdAtMs: 1,
  lastActivityAtMs: 1,
  cols: 80,
  rows: 24,
});

const serviceOver = (list: TerminalRuntimePort['list']) =>
  new ManagedTerminalService(
    { roots: async () => (await list()).map(record => record.root) } as unknown as TerminalRuntimePort,
    { resolve: async () => undefined },
    { now: () => 0 },
    { next: () => 'id' },
  );

describe('the folders open shells stand in (what worktree removal asks)', () => {
  it('should answer every live pane folder from the runtime', async () => {
    const service = serviceOver(async () => [held('a', '/work/one'), held('b', '/work/two')]);
    should(await service.roots()).deepEqual(['/work/one', '/work/two']);
  });

  it('should answer none when no shell is open', async () => {
    should(await serviceOver(async () => []).roots()).deepEqual([]);
  });

  it('should throw when tmux cannot list, so the caller reads it as unknown and never as none', async () => {
    const service = serviceOver(async () => {
      throw new Error('could not list terminal sessions');
    });
    let thrown = false;
    await service.roots().catch(() => (thrown = true));
    should(thrown).equal(true);
  });
});
