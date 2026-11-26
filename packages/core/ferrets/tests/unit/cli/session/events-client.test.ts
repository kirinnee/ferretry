import { expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { ClientSessionApi } from '../../../../cli/lib/client.ts';

const event = (sequence: number) => ({
  sequence,
  time: '2026-11-06T09:00:00.000Z',
  sessionId: 'fern',
  type: 'session.started',
  source: 'journal',
  data: {},
});

const journal = (pages: readonly unknown[][], calls: unknown[] = []): PluginClient => ({
  call: async <T>(key: string, init?: unknown): Promise<T> => {
    calls.push({ key, init });
    return (pages[calls.length - 1] ?? []) as T;
  },
  subscribe: () => () => {},
});

test('the journal is read after a cursor, a page at a time, until a short page ends it', async () => {
  const calls: unknown[] = [];
  const full = Array.from({ length: 1_000 }, (_, index) => event(index + 1));
  const api = new ClientSessionApi(journal([full, [event(1_001)]], calls));
  const events = await api.eventsAfter('fern', 0);
  expect(events.map(held => held.sequence)).toEqual([...full.map(held => held.sequence), 1_001]);
  expect(calls).toEqual([
    {
      key: 'GET /v1/ferrets/:ferretId/events',
      init: { params: { ferretId: 'fern' }, query: { after: '0', limit: '1000' }, quiet: true },
    },
    {
      key: 'GET /v1/ferrets/:ferretId/events',
      init: { params: { ferretId: 'fern' }, query: { after: '1000', limit: '1000' }, quiet: true },
    },
  ]);
});

test('an empty journal answers nothing, and a read the deadline abandons is dropped', async () => {
  expect(await new ClientSessionApi(journal([[]])).eventsAfter('fern', 4)).toEqual([]);
  const deadline = new AbortController();
  deadline.abort();
  await expect(new ClientSessionApi(journal([[event(1)]])).eventsAfter('fern', 0, deadline.signal)).rejects.toThrow(
    'abandoned',
  );
  const live = new AbortController();
  expect(await new ClientSessionApi(journal([[event(1)]])).eventsAfter('fern', 0, live.signal)).toHaveLength(1);
});
