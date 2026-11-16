/**
 * THE HELD READ: a polled route costs a `304` when nothing changed. The body a read last answered is held with its etag
 * and sent back as `If-None-Match`; a `304` keeps the held body, a `200` replaces it.
 */
import { describe, expect, it } from 'bun:test';
import { HELD_READ_LIMIT, heldRead, type HeldReadClient } from '../../../manifest/held-reads.ts';
import type { PluginConditionalAnswer, PluginConditionalInit } from '../../../manifest/implement.ts';

/** A client whose daemon holds one document at a time and names it by a counter, as a file's identity moves. */
function daemon() {
  const asked: Array<{ route: string; params: Record<string, string>; init: PluginConditionalInit | undefined }> = [];
  const state = { version: 1, tagged: true, calls: 0 };
  const client: HeldReadClient = {
    call: (async () => {
      state.calls += 1;
      return { v: state.version };
    }) as HeldReadClient['call'],
    async conditional(route, params, init): Promise<PluginConditionalAnswer> {
      asked.push({ route, params: { ...params }, init });
      const etag = `"v${String(state.version)}"`;
      if (init?.ifNoneMatch === etag) return { status: 304, etag };
      const body = { v: state.version, query: init?.query };
      return state.tagged ? { status: 200, etag, body } : { status: 200, body };
    },
  };
  return { client, state, asked };
}

describe('heldRead', () => {
  it('sends no validator the first time, then the etag it holds; a 304 keeps the held body', async () => {
    const { client, asked } = daemon();
    const first = await heldRead(client, 'GET /v1/x/:id', { params: { id: 'a' } });
    expect(first).toEqual({ body: { v: 1, query: undefined }, unchanged: false });

    const second = await heldRead(client, 'GET /v1/x/:id', { params: { id: 'a' } });

    expect(asked.map(each => each.init?.ifNoneMatch)).toEqual([undefined, '"v1"']);
    expect(second.unchanged).toBe(true);
    // The very object, so a caller can keep what it made of it.
    expect(second.body).toBe(first.body);
  });

  it('a 200 replaces the held body, and the next read sends the new etag', async () => {
    const { client, state, asked } = daemon();
    const first = await heldRead(client, 'GET /v1/x/:id', { params: { id: 'a' } });
    state.version = 2;

    const changed = await heldRead(client, 'GET /v1/x/:id', { params: { id: 'a' } });

    expect(changed.unchanged).toBe(false);
    expect(changed.body).not.toBe(first.body);
    expect(changed.body).toMatchObject({ v: 2 });
    expect((await heldRead(client, 'GET /v1/x/:id', { params: { id: 'a' } })).unchanged).toBe(true);
    expect(asked.map(each => each.init?.ifNoneMatch)).toEqual([undefined, '"v1"', '"v2"']);
  });

  it('holds each route, parameters, query and header set apart', async () => {
    const { client, asked } = daemon();
    await heldRead(client, 'GET /v1/x/:id', { params: { id: 'a' } });
    await heldRead(client, 'GET /v1/x/:id', { params: { id: 'b' } });
    await heldRead(client, 'GET /v1/x/:id', { params: { id: 'a' }, query: { limit: '1' } });
    await heldRead(client, 'GET /v1/x/:id', { params: { id: 'a' }, headers: { 'x-fy-agenda-channel': '2' } });
    await heldRead(client, 'GET /v1/y', {});
    // None of these held anything for the others.
    expect(asked.map(each => each.init?.ifNoneMatch)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    // The same query given in another order is the same read.
    await heldRead(client, 'GET /v1/x/:id', { params: { id: 'a' }, query: { a: '1', b: '2' } });
    await heldRead(client, 'GET /v1/x/:id', { params: { id: 'a' }, query: { b: '2', a: '1' } });
    expect(asked.at(-1)?.init?.ifNoneMatch).toBe('"v1"');
    expect(asked.at(-1)?.init?.query).toEqual({ b: '2', a: '1' });
  });

  it('holds nothing for an answer that named no etag, and reads it whole every time', async () => {
    const { client, state, asked } = daemon();
    state.tagged = false;
    await heldRead(client, 'GET /v1/x');
    await heldRead(client, 'GET /v1/x');
    expect(asked.map(each => each.init?.ifNoneMatch)).toEqual([undefined, undefined]);
  });

  it('forgets a held body once a later answer names no etag', async () => {
    const { client, state, asked } = daemon();
    await heldRead(client, 'GET /v1/x');
    state.tagged = false;
    state.version = 2;
    await heldRead(client, 'GET /v1/x');
    await heldRead(client, 'GET /v1/x');
    expect(asked.map(each => each.init?.ifNoneMatch)).toEqual([undefined, '"v1"', undefined]);
  });

  it('keeps a bounded memory, oldest first, and re-reads whole what it forgot', async () => {
    const { client, asked } = daemon();
    for (let at = 0; at <= HELD_READ_LIMIT; at += 1)
      await heldRead(client, 'GET /v1/x/:id', { params: { id: String(at) } });
    asked.length = 0;
    await heldRead(client, 'GET /v1/x/:id', { params: { id: '0' } });
    await heldRead(client, 'GET /v1/x/:id', { params: { id: String(HELD_READ_LIMIT) } });
    expect(asked.map(each => each.init?.ifNoneMatch)).toEqual([undefined, '"v1"']);
  });

  it('a read just served is the last to be forgotten', async () => {
    const { client, asked } = daemon();
    for (let at = 0; at < HELD_READ_LIMIT; at += 1)
      await heldRead(client, 'GET /v1/x/:id', { params: { id: String(at) } });
    await heldRead(client, 'GET /v1/x/:id', { params: { id: '0' } }); // a 304: 0 is now the newest
    await heldRead(client, 'GET /v1/x/:id', { params: { id: 'extra' } }); // pushes the oldest (1) out
    asked.length = 0;
    await heldRead(client, 'GET /v1/x/:id', { params: { id: '0' } });
    await heldRead(client, 'GET /v1/x/:id', { params: { id: '1' } });
    expect(asked.map(each => each.init?.ifNoneMatch)).toEqual(['"v1"', undefined]);
  });

  it('refuses a 304 to a read that sent no validator: it has no body to stand for', async () => {
    const client: HeldReadClient = {
      call: (async () => ({})) as HeldReadClient['call'],
      conditional: async () => ({ status: 304, etag: '"x"' }),
    };
    await expect(heldRead(client, 'GET /v1/x')).rejects.toThrow('304 Not Modified to a read that sent no validator');
  });

  it('reads through call, whole, from a client with no conditional read', async () => {
    const calls: unknown[] = [];
    const client: HeldReadClient = {
      call: (async (route: string, init: unknown) => {
        calls.push([route, init]);
        return { whole: true };
      }) as HeldReadClient['call'],
    };
    expect(
      await heldRead(client, 'GET /v1/x/:id', {
        params: { id: 'a' },
        query: { q: '1' },
        headers: { 'x-fy-agenda-channel': '2' },
      }),
    ).toEqual({
      body: { whole: true },
      unchanged: false,
    });
    expect(calls).toEqual([
      ['GET /v1/x/:id', { params: { id: 'a' }, query: { q: '1' }, headers: { 'x-fy-agenda-channel': '2' } }],
    ]);
    await heldRead(client, 'GET /v1/x');
    expect(calls.at(-1)).toEqual(['GET /v1/x', {}]);
  });

  it('lets a failure of the read through, holding what it held', async () => {
    const { client, state } = daemon();
    await heldRead(client, 'GET /v1/x');
    const failing: HeldReadClient = {
      call: client.call,
      conditional: async () => {
        throw new Error('carrier outage');
      },
    };
    await expect(heldRead(failing, 'GET /v1/x')).rejects.toThrow('carrier outage');
    state.version = 1;
    expect((await heldRead(client, 'GET /v1/x')).unchanged).toBe(true);
  });
});
