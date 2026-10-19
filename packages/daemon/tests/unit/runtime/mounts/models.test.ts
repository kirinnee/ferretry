import { describe, it } from 'bun:test';
import type { LocalModels } from '@ferretry/protocol';
import should from 'should';
import { modelRoutes } from '../../../../src/lib/runtime/mounts/models.ts';

const LOCAL: LocalModels = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  state: 'none-pulled',
  models: [],
  checkedAt: '2026-10-19T00:00:00.000Z',
  message: 'Ollama is running, but no model is installed yet. Run: ollama pull gpt-oss:20b',
  pullCommand: 'ollama pull gpt-oss:20b',
};

describe('modelRoutes', () => {
  it('should answer the catalogs, a refresh and a local read, governed as fleet.use for an operator', async () => {
    // Arrange
    const routes = modelRoutes({
      view: async () => ({ published: { origin: 'https://ferretry.pages.dev', enabled: true }, catalogs: [] }),
      refresh: async () => ({ outcome: 'unchanged', version: 3 }),
      refreshLocal: async () => LOCAL,
    });

    // Act
    const answers = await Promise.all(routes.map(route => route.handle({} as never)));

    // Assert
    should(routes.map(route => [route.method, route.path, route.minimum, route.capability])).deepEqual([
      ['GET', '/v1/models', 'operator', { capability: 'fleet', axis: 'use' }],
      ['POST', '/v1/models/refresh', 'operator', { capability: 'fleet', axis: 'use' }],
      ['POST', '/v1/models/local/refresh', 'operator', { capability: 'fleet', axis: 'use' }],
    ]);
    should(JSON.parse(String((answers[1] as { body: unknown }).body))).deepEqual({ outcome: 'unchanged', version: 3 });
    should(JSON.parse(String((answers[2] as { body: unknown }).body))).deepEqual(LOCAL);
  });
});
