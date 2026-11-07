import { describe, expect, test } from 'bun:test';
import { ApiError } from '../../../contract/http.ts';
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
  actions: {
    sockets: [socket('GET /v1/terminals/:key/stream', scoped), socket('GET /v1/terminals/:key/broken', scoped)],
  },
});

describe('UU the test host answers a socket accept that throws with its refusal, as the real upgrade does', () => {
  test('an ApiError keeps its status and body; any other throw is a bare 500', async () => {
    const half = implementDaemon(manifest, {
      build: () => ({
        sockets: {
          'GET /v1/terminals/:key/stream': async () => {
            throw new ApiError(404, 'There is no terminal x.', 'not_found');
          },
          'GET /v1/terminals/:key/broken': async () => {
            throw new Error('internal detail');
          },
        },
      }),
    });
    const host = await testHost({ plugins: [half] });
    const refused = await host.socket('/v1/terminals/x/stream');
    expect(refused.response?.status).toBe(404);
    expect(refused.response?.json()).toMatchObject({ error: 'There is no terminal x.', code: 'not_found' });
    const broken = await host.socket('/v1/terminals/x/broken');
    expect(broken.response?.status).toBe(500);
    expect(broken.response?.body.includes('internal detail')).toBe(false);
    await host.stop();
  });
});
