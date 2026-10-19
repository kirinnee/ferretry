import { describe, it } from 'bun:test';
import should from 'should';
import { modelRoutes } from '../../../../src/lib/runtime/mounts/models.ts';

describe('modelRoutes', () => {
  it('should answer the catalogs and a refresh, governed as fleet.use for an operator', async () => {
    // Arrange
    const routes = modelRoutes({
      view: async () => ({ published: { origin: 'https://ferretry.pages.dev', enabled: true }, catalogs: [] }),
      refresh: async () => ({ outcome: 'unchanged', version: 3 }),
    });

    // Act
    const answers = await Promise.all(routes.map(route => route.handle({} as never)));

    // Assert
    should(routes.map(route => [route.method, route.path, route.minimum, route.capability])).deepEqual([
      ['GET', '/v1/models', 'operator', { capability: 'fleet', axis: 'use' }],
      ['POST', '/v1/models/refresh', 'operator', { capability: 'fleet', axis: 'use' }],
    ]);
    should(JSON.parse(String((answers[1] as { body: unknown }).body))).deepEqual({ outcome: 'unchanged', version: 3 });
  });
});
