import { describe, expect, test } from 'bun:test';
import { queryValue } from '../../../contract/http.ts';
import { definePlugin, implementDaemon, socket } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const scoped = { minimum: 'authenticated', caller: 'any', audit: { skip: 'test' }, guard: { none: 'test' } } as const;
const manifest = definePlugin({
  id: 'terminals',
  title: 'Terminals',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: { sockets: [socket('GET /v1/terminals/:key/stream', scoped)] },
});

describe('a socket’s query reaches its accept handler', () => {
  test('the query values arrive intact beside the path params, which only fill the placeholders', async () => {
    const seen: { key: string | undefined; after: string | undefined; sessionId: string | undefined }[] = [];
    const half = implementDaemon(manifest, {
      build: () => ({
        sockets: {
          'GET /v1/terminals/:key/stream': async call => {
            seen.push({
              key: call.params.get('key'),
              after: queryValue(call.request, 'after'),
              sessionId: queryValue(call.request, 'sessionId'),
            });
            return async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined });
          },
        },
      }),
    });
    const host = await testHost({ plugins: [half] });
    await host.socket('/v1/terminals/x/stream', { query: { after: '3', sessionId: 'a b&c=d' } });
    await host.socket('/v1/terminals/y/stream');
    expect(seen).toEqual([
      { key: 'x', after: '3', sessionId: 'a b&c=d' },
      { key: 'y', after: undefined, sessionId: undefined },
    ]);
    await host.stop();
  });
});
