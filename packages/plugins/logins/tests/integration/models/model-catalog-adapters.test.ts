import { describe, it } from 'bun:test';
import type { StateRead } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import should from 'should';
import { HostedModelCatalog } from '../../../daemon/adapters/models/hosted-model-catalog.ts';
import { StateModelCatalogCache } from '../../../daemon/adapters/models/state-model-catalog-cache.ts';
import { realClock, realFetch } from '../../support/real-ports.ts';

/** The one declared file, in memory: enough of the kernel's state port for the cache to be read and written. */
function memoryState() {
  let held: unknown;
  return {
    read: async () => ok(held) as StateRead<never>,
    update: async (_file: unknown, fn: (current: unknown) => unknown) => {
      held = fn(held);
      return ok(held);
    },
    get held() {
      return held;
    },
  };
}

describe('the state model catalog cache', () => {
  it('should keep what it is given, and read a missing or half-written document as nothing held', async () => {
    // Arrange
    const state = memoryState();
    const cache = new StateModelCatalogCache(state as never);

    // Act / Assert
    should(await cache.read()).be.undefined();
    await cache.write({ version: 3 });
    should(await cache.read()).be.undefined();
    await cache.write({
      version: 3,
      document: { catalogs: {} },
      fetchedAt: '2026-10-19T00:00:00.000Z',
      checkedAt: '2026-10-19T00:00:00.000Z',
    });
    should(await cache.read()).deepEqual({
      version: 3,
      document: { catalogs: {} },
      fetchedAt: '2026-10-19T00:00:00.000Z',
      checkedAt: '2026-10-19T00:00:00.000Z',
    });
  });
});

describe('the hosted model catalog read', () => {
  it('should ask one address under the origin with no credential and no cache, and hand back the bytes', async () => {
    // Arrange — a local server stands in for the hosted app
    const asked: { path: string; cookie: string | null }[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        asked.push({ path: new URL(request.url).pathname, cookie: request.headers.get('cookie') });
        return new Response('{"version":5}', { status: 200 });
      },
    });
    try {
      // Act
      const answer = await new HostedModelCatalog(`http://127.0.0.1:${server.port}/`, realFetch, realClock).get(
        'catalog/version.json',
      );

      // Assert
      should(answer?.status).equal(200);
      should(new TextDecoder().decode(answer?.bytes)).equal('{"version":5}');
      should(asked).deepEqual([{ path: '/catalog/version.json', cookie: null }]);
    } finally {
      server.stop(true);
    }
  });

  it('should answer nothing, never throw, when the origin cannot be reached', async () => {
    // Arrange
    const down = new HostedModelCatalog(
      'https://hosted.invalid',
      {
        request: async () => {
          throw new TypeError('fetch failed');
        },
      },
      realClock,
    );

    // Act / Assert
    should(await down.get('catalog/version.json')).be.undefined();
  });
});
