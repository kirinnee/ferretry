import { describe, expect, test } from 'bun:test';
import { jsonResponse } from '../../../contract/http.ts';
import type { PluginClient } from '../../../manifest/implement.ts';
import { definePlugin, implementDaemon, route } from '../../../manifest/index.ts';
import { testHost, testPluginClient } from '../../../testing/index.ts';

const scoped = { minimum: 'authenticated', caller: 'any', audit: { skip: 'test' }, guard: { none: 'test' } } as const;
const manifest = definePlugin({
  id: 'ferrets',
  title: 'Ferrets',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: { routes: [route('GET /v1/ferrets/:id/list', { ...scoped, noStore: true })] },
});

describe('YY PluginClient.conditional: the held list read, 200 with an etag or 304', () => {
  test('the test double sends If-None-Match and maps the answer', async () => {
    let version = 'v1';
    const half = implementDaemon(manifest, {
      build: () => ({
        routes: {
          'GET /v1/ferrets/:id/list': async ({ request }) => {
            const etag = `"${version}"`;
            if (request.headers.get('if-none-match') === etag)
              return { status: 304, headers: new Map([['etag', etag]]), body: '' };
            const answer = jsonResponse({ ferrets: [version] });
            return { ...answer, headers: new Map([...answer.headers, ['etag', etag]]) };
          },
        },
      }),
    });
    const host = await testHost({ plugins: [half] });
    const client: PluginClient = testPluginClient(host);
    const first = await client.conditional?.('GET /v1/ferrets/:id/list', { id: 'F1' });
    expect(first).toEqual({ status: 200, etag: '"v1"', body: { ferrets: ['v1'] } });
    expect(await client.conditional?.('GET /v1/ferrets/:id/list', { id: 'F1' }, { ifNoneMatch: '"v1"' })).toEqual({
      status: 304,
      etag: '"v1"',
    });
    version = 'v2';
    expect(
      (await client.conditional?.('GET /v1/ferrets/:id/list', { id: 'F1' }, { ifNoneMatch: '"v1"' }))?.status,
    ).toBe(200);
    await host.stop();
  });
});

describe('YY PluginClient.call: a caller that may stop waiting', () => {
  const make = async (release: Promise<void>) => {
    const half = implementDaemon(manifest, {
      build: () => ({
        routes: {
          'GET /v1/ferrets/:id/list': async () => {
            await release;
            return jsonResponse({ ferrets: [] });
          },
        },
      }),
    });
    return await testHost({ plugins: [half] });
  };

  test('an aborted call ends at once with the signal’s reason', async () => {
    let open: () => void = () => {};
    const host = await make(new Promise<void>(resolve => (open = resolve)));
    const client = testPluginClient(host);
    const caller = new AbortController();
    const waiting = client
      .call('GET /v1/ferrets/:id/list', { params: { id: 'F1' }, signal: caller.signal })
      .catch((error: unknown) => error);
    caller.abort(new Error('gave up'));
    expect(((await waiting) as Error).message).toBe('gave up');
    open();
    await host.stop();
  });

  test('a call already aborted never reaches the host', async () => {
    const host = await make(Promise.resolve());
    const caller = new AbortController();
    caller.abort(new Error('gave up'));
    await expect(
      testPluginClient(host).call('GET /v1/ferrets/:id/list', { params: { id: 'F1' }, signal: caller.signal }),
    ).rejects.toThrow('gave up');
    await host.stop();
  });

  test('an abort after the answer is a no-op', async () => {
    const host = await make(Promise.resolve());
    const caller = new AbortController();
    const answer = await testPluginClient(host).call('GET /v1/ferrets/:id/list', {
      params: { id: 'F1' },
      signal: caller.signal,
    });
    caller.abort();
    expect(answer).toEqual({ ferrets: [] });
    await host.stop();
  });
});
