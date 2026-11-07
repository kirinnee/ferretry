/**
 * The Voice-owned R rows of docs/design/rebuild-parity.tsv, one test per row, each named by its id, driven through the
 * real daemon half on the kernel's test host. The paths are today's (no replaced word); `descriptor-parity` compares the
 * descriptor fields.
 */
import { describe, expect, test } from 'bun:test';
import { owner } from '@ferretry/kernel/testing';
import { SpeedupTestResultSchema, SpeedupsViewSchema, SttEnhancementResultSchema } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { CEREBRAS_KEY, GROQ_KEY, voiceHost } from './host.ts';

describe('the voice routes', () => {
  test('R-0400 POST /v1/stt/enhance answers the repaired transcript, never the key', async () => {
    const { host } = await voiceHost();
    const response = await host.request('POST', '/v1/stt/enhance', {
      body: { text: 'helo wold', provider: 'groq' },
      as: owner(),
    });
    expect(response.status).toBe(200);
    expect(SttEnhancementResultSchema.parse(response.json()).text).toBe('Hello, world.');
    expect(String(response.body)).not.toContain(GROQ_KEY);
  });

  test('R-0199 GET /v1/speedups lists each provider by name, set or not, never a value', async () => {
    const { host } = await voiceHost();
    const response = await host.request('GET', '/v1/speedups', { as: owner() });
    const view = SpeedupsViewSchema.parse(response.json());
    expect(view.providers.map(provider => [provider.provider, provider.set])).toEqual([
      ['jev', false],
      ['groq', true],
      ['cerebras', false],
    ]);
    expect(String(response.body)).not.toContain(GROQ_KEY);
  });

  test('R-0397 POST /v1/speedups/:provider/test tests one key and remembers the answer', async () => {
    const { host } = await voiceHost({ CEREBRAS_API_KEY: CEREBRAS_KEY }, () => ({
      kind: 'completion',
      payload: { data: [] },
    }));
    const response = await host.request('POST', '/v1/speedups/cerebras/test', { as: owner() });
    expect(SpeedupTestResultSchema.parse(response.json())).toMatchObject({ provider: 'cerebras', ok: true });
    const view = SpeedupsViewSchema.parse((await host.request('GET', '/v1/speedups', { as: owner() })).json());
    expect(view.providers.find(provider => provider.provider === 'cerebras')?.lastTest?.ok).toBe(true);
    expect((await host.request('POST', '/v1/speedups/openai/test', { as: owner() })).status).toBe(404);
  });

  test('the three routes are declared at today’s paths', () => {
    expect(manifest.actions.routes.map(route => route.key)).toEqual([
      'POST /v1/stt/enhance',
      'GET /v1/speedups',
      'POST /v1/speedups/:provider/test',
    ]);
  });
});
