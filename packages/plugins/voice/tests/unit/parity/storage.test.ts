/** The Voice-owned F rows of docs/design/rebuild-parity.tsv, each named by its id, over the real daemon half. */
import { describe, expect, test } from 'bun:test';
import { owner } from '@ferretry/kernel/testing';
import { SPEEDUP_TESTS_STATE, VOICE_CONFIG } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { CEREBRAS_KEY, voiceHost } from './host.ts';

describe('the voice files', () => {
  test('F-0176 F-0419 config/voice.yaml is read per call: cleanup switched off refuses without sending', async () => {
    expect(VOICE_CONFIG.file).toBe('voice.yaml');
    expect(manifest.data.config.map(config => ('file' in config ? config.file : undefined))).toEqual(['voice.yaml']);
    const { host, sent } = await voiceHost(undefined, undefined, {
      postProcessing: { provider: 'groq', style: 'off' },
    });
    const response = await host.request('POST', '/v1/stt/enhance', {
      body: { text: 'helo wold', provider: 'groq' },
      as: owner(),
    });
    expect(response.status).toBe(400);
    expect(sent).toEqual([]);
  });

  test('F-0348 state/speedups.json is state/voice/speedup-tests.json: names, codes and instants under format 1', async () => {
    expect(SPEEDUP_TESTS_STATE.path).toBe('speedup-tests.json');
    expect(SPEEDUP_TESTS_STATE.format).toBe(1);
    const { host } = await voiceHost({ CEREBRAS_API_KEY: CEREBRAS_KEY }, () => ({
      kind: 'completion',
      payload: { data: [] },
    }));
    await host.request('POST', '/v1/speedups/cerebras/test', { as: owner() });
    const raw = host.state('voice').raw(SPEEDUP_TESTS_STATE) ?? '';
    expect(raw).toContain('"format":1');
    expect(raw).toContain('cerebras');
    expect(raw).not.toContain(CEREBRAS_KEY);
  });
});
