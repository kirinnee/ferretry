import { describe, it } from 'bun:test';
import type { ApiResponse } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import should from 'should';
import type { LocalModels } from '../../../contract/index.ts';
import { modelRoutes } from '../../../daemon/lib/routes/models.ts';
import { call } from '../../support/call-route.ts';

const LOCAL: LocalModels = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  state: 'none-pulled',
  models: [],
  checkedAt: '2026-10-19T00:00:00.000Z' as Instant,
  message: 'Ollama is running, but no model is installed yet. Run: ollama pull gpt-oss:20b',
  pullCommand: 'ollama pull gpt-oss:20b',
};

const json = (response: ApiResponse): unknown => JSON.parse(String((response as { body: unknown }).body));

describe('modelRoutes', () => {
  it('should answer the catalogs, a refresh and a local read on the paths `/v1/models*` has always had', async () => {
    // Arrange
    const routes = modelRoutes({
      view: async () => ({ published: { origin: 'https://ferretry.pages.dev', enabled: true }, catalogs: [] }),
      refresh: async () => ({ outcome: 'unchanged', version: 3 }),
      refreshLocal: async () => LOCAL,
    });

    // Act
    const answers = [
      await call(routes, 'GET /v1/models'),
      await call(routes, 'POST /v1/models/refresh'),
      await call(routes, 'POST /v1/models/local/refresh'),
    ];

    // Assert
    should(Object.keys(routes)).deepEqual(['GET /v1/models', 'POST /v1/models/refresh', 'POST /v1/models/local/refresh']);
    should(answers.map(answer => answer.status)).deepEqual([200, 200, 200]);
    should(json(answers[1] as ApiResponse)).deepEqual({ outcome: 'unchanged', version: 3 });
    should(json(answers[2] as ApiResponse)).deepEqual(LOCAL);
  });
});
