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
