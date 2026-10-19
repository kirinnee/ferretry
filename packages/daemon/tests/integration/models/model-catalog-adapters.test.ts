import { describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileModelCatalogCache, HostedModelCatalog, type ModelCatalogCacheFiles } from '../../../src/adapters/index.ts';

const files: ModelCatalogCacheFiles = {
  readText: async path => await readFile(path, 'utf8').catch(() => undefined),
  writeTextAtomic: async (path, text) => await writeFile(path, text),
};

describe('the file model catalog cache', () => {
  it('should keep what it is given, and read a missing, empty or damaged file as nothing held', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fy-model-catalog-'));
    try {
      // Arrange
      const cache = new FileModelCatalogCache(files, join(directory, 'model-catalog.json'));

      // Act / Assert
      should(await cache.read()).be.undefined();
      await cache.write({ version: 3 });
      should(await cache.read()).deepEqual({ version: 3 });
      await writeFile(join(directory, 'model-catalog.json'), '   ');
      should(await cache.read()).be.undefined();
      await writeFile(join(directory, 'model-catalog.json'), '{nope');
      should(await cache.read()).be.undefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      const answer = await new HostedModelCatalog(`http://127.0.0.1:${server.port}/`).get('catalog/version.json');

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
    const down = new HostedModelCatalog('https://hosted.invalid', async () => {
      throw new TypeError('fetch failed');
    });

    // Act / Assert
    should(await down.get('catalog/version.json')).be.undefined();
  });
});
