import { describe, expect, test } from 'bun:test';
import { createPackTableFeed } from '../../../app/lib/pack-table-feed.ts';

const TABLE = {
  root: { id: 'lead', name: 'lead' },
  at: '2026-10-20T02:00:00.000Z',
  endedWindowMs: 0,
  rows: [{ id: 'mvnadia-1', name: 'nadia', depth: 1, model: 'm', state: 'running', ferretState: 'working' }],
};

const scripted = () => {
  const calls: string[] = [];
  let answer: unknown = TABLE;
  return {
    calls,
    set: (next: unknown) => {
      answer = next;
    },
    client: {
      call: async (_key: string, init?: { params?: Record<string, string> }) => {
        calls.push(init?.params?.['ferretId'] ?? '');
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as never,
  };
};

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('the shared pack table read', () => {
  test('many cards of one ferret share one read and one timer; the last to leave stops both', async () => {
    const api = scripted();
    let timers = 0;
    let stops = 0;
    const feed = createPackTableFeed(api.client, () => {
      timers += 1;
      return () => {
        stops += 1;
      };
    });
    let changed = 0;
    const leaveA = feed.watch('lead', () => (changed += 1));
    const leaveB = feed.watch('lead', () => (changed += 1));
    await settle();
    expect(api.calls).toEqual(['lead']);
    expect(timers).toBe(1);
    expect(feed.rows('lead')?.map(row => row.id)).toEqual(['mvnadia-1']);
    expect(changed).toBe(2);
    leaveA();
    expect(stops).toBe(0);
    leaveB();
    expect(stops).toBe(1);
    expect(feed.rows('lead')).toBeUndefined();
  });

  test('a failed read leaves the rows as they were, and a malformed table is not trusted', async () => {
    const api = scripted();
    let tick: () => void = () => undefined;
    const feed = createPackTableFeed(api.client, (_ms, run) => {
      tick = run;
      return () => undefined;
    });
    feed.watch('lead', () => undefined);
    await settle();
    api.set(new Error('offline'));
    tick();
    await settle();
    expect(feed.rows('lead')).toHaveLength(1);
    api.set({ nonsense: true });
    tick();
    await settle();
    expect(feed.rows('lead')).toHaveLength(1);
  });
});
