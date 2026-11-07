import { describe, expect, test } from 'bun:test';
import { HeldFleetList } from '../../../../cli/lib/session/held-list.ts';
import { T0 } from '../../../../contract/testing/index.ts';

const summary = (id: string) => ({
  id,
  name: id,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: `/work/${id}`,
  state: 'working',
  createdAt: T0,
  stateAt: T0,
});

describe('the held fleet list', () => {
  test('R502 the client keeps one last list and answers a 304 with a fresh copy of it', async () => {
    const sent: Record<string, string>[] = [];
    const body = JSON.stringify([summary('a')]);
    const reader = new HeldFleetList(async headers => {
      sent.push({ ...headers });
      return sent.length === 1 ? { status: 200, etag: '"t1"', body } : { status: 304, etag: '"t1"', body: '' };
    });
    const first = await reader.list();
    const second = await reader.list();
    expect(sent).toEqual([{}, { 'if-none-match': '"t1"' }]);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    (second[0] as { name: string }).name = 'changed by a caller';
    expect((await reader.list())[0]?.name).toBe('a');
  });

  test('R502 an answer with no etag holds nothing: the next read is a full one', async () => {
    const sent: Record<string, string>[] = [];
    const reader = new HeldFleetList(async headers => {
      sent.push({ ...headers });
      return { status: 200, body: JSON.stringify([summary('a')]) };
    });
    await reader.list();
    await reader.list();
    expect(sent).toEqual([{}, {}]);
  });
});
