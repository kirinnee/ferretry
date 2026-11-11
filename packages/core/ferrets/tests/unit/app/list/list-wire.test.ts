import { describe, expect, it } from 'bun:test';
import { readFerretList, UNREADABLE_LIST } from '../../../../app/features/list/list-wire.ts';
import type { LiveFerretsClient } from '../../../../app/lib/client.ts';
import { ferretSummary } from '../header/support.ts';

type Conditional = NonNullable<LiveFerretsClient['conditional']>;

describe('reading the ferret list', () => {
  it('reads GET /v1/ferrets through call when the client has no conditional read', async () => {
    const client: LiveFerretsClient = { call: (async () => [ferretSummary('a')]) as LiveFerretsClient['call'] };
    expect(await readFerretList(client)).toEqual({ ferrets: [ferretSummary('a')] });
  });

  it('an element that does not parse fails the whole read in words', async () => {
    const client: LiveFerretsClient = { call: (async () => [ferretSummary('a'), { id: 'x' }]) as never };
    await expect(readFerretList(client)).rejects.toThrow(UNREADABLE_LIST);
    const notAList: LiveFerretsClient = { call: (async () => ({})) as never };
    await expect(readFerretList(notAList)).rejects.toThrow(UNREADABLE_LIST);
  });

  it('sends the etag it holds, keeps the held rows on a 304 and takes a new etag on a 200', async () => {
    const sent: unknown[] = [];
    let next: Awaited<ReturnType<Conditional>> = { status: 200, etag: '"e1"', body: [ferretSummary('a')] };
    const client: LiveFerretsClient = {
      call: (async () => []) as never,
      conditional: async (_key, _params, init) => {
        sent.push(init);
        return next;
      },
    };
    const first = await readFerretList(client);
    expect(first).toEqual({ ferrets: [ferretSummary('a')], etag: '"e1"' });
    next = { status: 304 };
    expect(await readFerretList(client, first)).toBe(first);
    expect(sent).toEqual([{}, { ifNoneMatch: '"e1"' }]);
    next = { status: 200, body: [] };
    expect(await readFerretList(client, first)).toEqual({ ferrets: [] });
  });

  it('a 304 with nothing held is not a list this page can read', async () => {
    const client: LiveFerretsClient = {
      call: (async () => []) as never,
      conditional: async () => ({ status: 304 }),
    };
    await expect(readFerretList(client)).rejects.toThrow(UNREADABLE_LIST);
  });
});
