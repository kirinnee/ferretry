import { describe, expect, test } from 'bun:test';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { buildSearch } from '../../../daemon/search/index.ts';
import { NOW_MS } from '../../support/work.ts';

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
  redaction: { read: async fn => await fn({ text: s => s.replaceAll('hunter2', '[redacted]'), cells: g => g, lines: l => l }) },
  now: () => NOW_MS,
  warn: () => undefined,
});

const get = (query: Record<string, string>) =>
  ({
    request: { query: new Map(Object.entries(query).map(([k, v]) => [k, [v]])), headers: new Map(), text: async () => '' } as unknown as ApiRequest,
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
