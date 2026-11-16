import { describe, expect, test } from 'bun:test';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { buildSearch } from '../../../daemon/search/index.ts';
import { cardWork, FakeSource, NOW_MS, query } from '../../support/work.ts';

const asks = {
  open: async ({ state }: { state?: string }) =>
    state === 'open'
      ? [
          {
            id: 'a1',
            source: 'question',
            entry: 'e1',
            kind: 'question',
            subject: 'Pick a search backend',
            raisedBy: { kind: 'ferret' },
            ferret: 'lead',
            state: 'open',
            raisedAt: '2026-10-30T09:00:00.000Z',
          },
        ]
      : [],
} as never;

const built = buildSearch({
  asks,
  redaction: {
    read: async fn => await fn({ text: s => s.replaceAll('hunter2', '[redacted]'), cells: g => g, lines: l => l }),
  },
  now: () => NOW_MS,
  warn: () => undefined,
});

const get = (query: Record<string, string>) =>
  ({
    request: {
      query: new Map(Object.entries(query).map(([k, v]) => [k, [v]])),
      headers: new Map(),
      text: async () => '',
    } as unknown as ApiRequest,
    params: new Map(),
  }) as never;

describe('the search routes and tool', () => {
  test('GET /v1/search answers the hits of the query string', async () => {
    const response = await built.routes['GET /v1/search'](get({ q: 'backend', kind: 'ask' }));
    const body = JSON.parse(response.body) as { hits: { id: string; kind: string }[]; indexed: { asks: number } };
    expect(body.hits.map(hit => hit.id)).toEqual(['a1']);
    expect(body.indexed.asks).toBe(1);
  });

  test('a query that is not usable is a 400 naming the field', async () => {
    const refusal = await built.routes['GET /v1/search'](get({ q: 'x', limit: '9999' })).then(
      () => undefined,
      (error: unknown) => error as { status: number; code?: string },
    );
    expect(refusal?.status).toBe(400);
    expect(refusal?.code).toBe('invalid');
  });

  test('the search_work tool answers the lines a model reads, with the hits as data', async () => {
    const result = await built.tools.search_work(undefined, { query: 'backend' });
    expect(result.text).toContain('!a1 ask [open] (ask of lead) Pick a search backend');
    expect(result.isError).toBeUndefined();
    expect((await built.tools.search_work(undefined, { query: '' })).isError).toBe(true);
  });
});

describe('v4 spellings of the search kind and the text of an agenda item', () => {
  test('--kind agenda and --kind task are the ask and card kinds', async () => {
    const agenda = JSON.parse((await built.routes['GET /v1/search'](get({ q: 'backend', kind: 'agenda' }))).body) as {
      hits: { id: string }[];
    };
    const task = JSON.parse((await built.routes['GET /v1/search'](get({ q: 'backend', kind: 'task' }))).body) as {
      hits: { id: string }[];
    };
    expect(agenda.hits.map(hit => hit.id)).toEqual(['a1']);
    expect(task.hits).toEqual([]);
  });

  test('the search_work tool takes kind task or agenda', async () => {
    const result = await built.tools.search_work(undefined, { query: 'backend', kind: 'agenda' });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('!a1');
  });

  test('an ask is found by the premise, context and body of its item, not by its subject alone', async () => {
    const summary = {
      id: 'A4',
      source: 'question',
      entry: 'e4',
      kind: 'question',
      subject: 'Pick one',
      raisedBy: { kind: 'ferret' },
      ferret: 'lead',
      state: 'open',
      raisedAt: '2026-10-30T09:00:00.000Z',
    };
    const board = {
      sessionId: 'lead',
      items: [
        {
          id: 'A4',
          subject: 'Pick one',
          premise: 'The signup form needs an ask on its first step',
          why: 'blocks launch',
        },
      ],
      resolved: [],
    };
    const search = buildSearch({
      asks: {
        open: async ({ state }: { state?: string }) => (state === 'open' ? [summary] : []),
        snapshots: async () => [board],
      } as never,
      redaction: { read: async fn => await fn({ text: s => s, cells: g => g, lines: l => l }) },
      now: () => NOW_MS,
      warn: () => undefined,
    });

    const found = await search.service.search(query('form ask'));

    expect(found.hits.map(hit => hit.id)).toEqual(['A4']);
    expect(found.hits[0]?.match.field).toBe('premise');
  });
});

describe('buildSearch', () => {
  const plain = {
    read: async <T>(fn: (scope: never) => T | Promise<T>) => await fn({ text: (s: string) => s } as never),
  };
  const none = { open: async () => [] } as never;

  test('searches the sources other plugins contribute, asked again on every search', async () => {
    const contributed: FakeSource[] = [];
    const search = buildSearch({
      asks: none,
      redaction: plain as never,
      sources: () => contributed,
      now: () => NOW_MS,
      warn: () => undefined,
    });
    expect((await search.service.search(query('relay'))).total).toBe(0);
    contributed.push(new FakeSource('cards', [cardWork({ id: 'F7', title: 'Relay carrier' })], true));
    expect((await search.service.search(query('relay'))).hits.map(hit => hit.id)).toEqual(['F7']);
  });

  test('a redaction generation that moves rebuilds the index; one that cannot be read fails closed', async () => {
    let generation: string | Error = 'g1';
    let lists = 0;
    const source = new FakeSource('cards', [cardWork({ id: 'F7', title: 'Relay carrier' })]);
    const counting = {
      id: 'cards',
      list: async () => {
        lists += 1;
        return await source.list();
      },
    };
    const search = buildSearch({
      asks: none,
      redaction: plain as never,
      generation: () => {
        if (generation instanceof Error) throw generation;
        return generation;
      },
      sources: () => [counting],
      now: () => NOW_MS,
      warn: () => undefined,
    });
    await search.service.search(query('relay'));
    await search.service.search(query('relay'));
    expect(lists).toBe(1);
    generation = 'g2';
    await search.service.search(query('relay'));
    expect(lists).toBe(2);
    generation = new Error('the vault will not say');
    await expect(search.service.search(query('relay'))).rejects.toThrow('the vault will not say');
  });
});
