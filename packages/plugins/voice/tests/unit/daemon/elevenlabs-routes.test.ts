import { describe, expect, test } from 'bun:test';
import type { AuthorizedOutcome, OutboundHttpRequest } from '@ferretry/core-vault/contract';
import { ferret, owner, warden } from '@ferretry/kernel/testing';
import {
  ElevenLabsStatusSchema,
  ElevenLabsVoicesSchema,
  SpeedupTestResultSchema,
  SpeedupsViewSchema,
  VoiceConfigSchema,
  voiceLoosens,
} from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { voiceHost } from '../parity/host.ts';

const XI_KEY = 'xi_test_0123456789abcdef';
const VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const config = { replyVoice: { provider: 'elevenlabs', elevenlabs: { voiceId: VOICE } } };

const voices = (): AuthorizedOutcome => ({
  kind: 'completion',
  payload: { voices: [{ voice_id: VOICE, name: 'George', category: 'premade' }], has_more: false },
});

describe('the ElevenLabs reply voice on the daemon', () => {
  test('its two routes are declared: the status is a voice.use read, the voice list is a person’s use of a secret, audited', () => {
    const status = manifest.actions.routes.find(route => route.key === 'GET /v1/voice/reply-voice/elevenlabs');
    const list = manifest.actions.routes.find(route => route.key === 'GET /v1/voice/reply-voice/elevenlabs/voices');
    expect(status?.capability).toMatchObject({ capability: 'voice', axis: 'use' });
    expect(list?.capability).toMatchObject({ capability: 'secrets', axis: 'use' });
    expect(list?.caller).toBe('person');
    expect(JSON.stringify(list?.audit)).toContain('secrets.used');
    expect([status?.noStore, list?.noStore]).toEqual([true, true]);
  });

  test('the manifest lets the key reach ElevenLabs and nowhere else, by name', () => {
    expect(manifest.permissions?.network).toContain('api.elevenlabs.io');
    expect(manifest.permissions?.secrets).toContain('ELEVENLABS_API_KEY');
  });

  test('the status says whether a key is set and what is spent, and never the key', async () => {
    const { host } = await voiceHost({ ELEVENLABS_API_KEY: XI_KEY }, () => voices(), config);
    const response = await host.request('GET', '/v1/voice/reply-voice/elevenlabs', { as: owner() });
    expect(response.status).toBe(200);
    const status = ElevenLabsStatusSchema.parse(response.json());
    expect(status).toMatchObject({ keySet: true, voiceId: VOICE, model: 'eleven_flash_v2_5' });
    expect(status.usage).toMatchObject({ usedChars: 0, dailyChars: 20_000 });
    expect(String(response.body)).not.toContain(XI_KEY);
    const bare = await voiceHost({}, () => voices(), config);
    expect(
      ElevenLabsStatusSchema.parse(
        (await bare.host.request('GET', '/v1/voice/reply-voice/elevenlabs', { as: owner() })).json(),
      ).keySet,
    ).toBe(false);
  });

  test('the voice list reads the account through the holder with the xi-api-key placement; the answer holds only ids and names', async () => {
    const { host, sent } = await voiceHost({ ELEVENLABS_API_KEY: XI_KEY }, () => voices(), config);
    const response = await host.request('GET', '/v1/voice/reply-voice/elevenlabs/voices', { as: owner() });
    expect(ElevenLabsVoicesSchema.parse(response.json())).toEqual({
      voices: [{ id: VOICE, name: 'George', category: 'premade' }],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toStartWith('https://api.elevenlabs.io/v2/voices');
    // The fake holder's own view of the request: the key is placed by it, as xi-api-key, and only there.
    expect((sent[0] as OutboundHttpRequest).headers['xi-api-key']).toBe(XI_KEY);
    expect(String(response.body)).not.toContain(XI_KEY);
  });

  test('a ferret and a warden may not list the voices (no unattended use of the key); nothing is sent', async () => {
    const { host, sent } = await voiceHost({ ELEVENLABS_API_KEY: XI_KEY }, () => voices(), config);
    for (const caller of [ferret('f1'), warden()]) {
      expect((await host.request('GET', '/v1/voice/reply-voice/elevenlabs/voices', { as: caller })).status).toBe(403);
    }
    expect(sent).toHaveLength(0);
  });

  test('a list with no key says not_set instead of an empty page', async () => {
    const { host } = await voiceHost({}, () => voices(), config);
    const listed = ElevenLabsVoicesSchema.parse(
      (await host.request('GET', '/v1/voice/reply-voice/elevenlabs/voices', { as: owner() })).json(),
    );
    expect(listed).toMatchObject({ voices: [], failure: { code: 'not_set' } });
  });

  test('it is the fourth Speed-up: the key row lists it, and Test is a free GET of /v1/models with the xi-api-key placement', async () => {
    const { host, sent } = await voiceHost(
      { ELEVENLABS_API_KEY: XI_KEY },
      () => ({ kind: 'completion', payload: [] }),
      config,
    );
    const view = SpeedupsViewSchema.parse((await host.request('GET', '/v1/speedups', { as: owner() })).json());
    expect(view.providers.find(entry => entry.provider === 'elevenlabs')).toMatchObject({
      label: 'ElevenLabs',
      secretName: 'ELEVENLABS_API_KEY',
      set: true,
    });
    const tested = await host.request('POST', '/v1/speedups/elevenlabs/test', { as: owner() });
    expect(SpeedupTestResultSchema.parse(tested.json())).toMatchObject({
      provider: 'elevenlabs',
      ok: true,
      code: 'ok',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'GET', url: 'https://api.elevenlabs.io/v1/models' });
    expect(sent[0]?.headers['xi-api-key']).toBe(XI_KEY);
    expect(sent[0]?.headers.authorization).toBeUndefined();
    expect(sent[0]?.body).toBeUndefined();
  });

  test('voice.yaml: the default is Kokoro, and a key-shaped field in the reply voice is refused', () => {
    expect(VoiceConfigSchema.parse({}).replyVoice).toMatchObject({
      provider: 'kokoro',
      elevenlabs: { model: 'eleven_flash_v2_5', dailyChars: 20_000 },
    });
    expect(VoiceConfigSchema.safeParse({ replyVoice: { elevenlabs: { apiKey: 'xi_x' } } }).success).toBe(false);
    expect(VoiceConfigSchema.safeParse({ replyVoice: { elevenlabs: { voiceId: '../../v1/user' } } }).success).toBe(
      false,
    );
    expect(VoiceConfigSchema.safeParse({ replyVoice: { elevenlabs: { dailyChars: 0 } } }).success).toBe(false);
    expect(VoiceConfigSchema.safeParse({ replyVoice: { provider: 'openai' } }).success).toBe(false);
  });
});

describe('what loosens in the reply voice is held for the owner', () => {
  const voiceWith = (replyVoice: Record<string, unknown>) => VoiceConfigSchema.parse({ replyVoice });

  test('moving the spoken lines to ElevenLabs is held; moving back, or choosing another voice, is not', () => {
    const on = voiceWith({ provider: 'elevenlabs', elevenlabs: { voiceId: VOICE } });
    expect(voiceLoosens(undefined, on)).toEqual([
      'a ferret’s spoken lines now go to ElevenLabs to be read aloud, billed per character',
    ]);
    expect(voiceLoosens(on, undefined)).toEqual([]);
    expect(voiceLoosens(on, voiceWith({ provider: 'elevenlabs', elevenlabs: { voiceId: 'a'.repeat(20) } }))).toEqual(
      [],
    );
  });

  test('a pricier model and a higher daily cap are held; a lower cap is not', () => {
    const base = voiceWith({ provider: 'elevenlabs', elevenlabs: { voiceId: VOICE, dailyChars: 10_000 } });
    expect(
      voiceLoosens(base, voiceWith({ provider: 'elevenlabs', elevenlabs: { voiceId: VOICE, dailyChars: 50_000 } })),
    ).toEqual(['the most ElevenLabs may speak in a day rises to 50,000 characters']);
    expect(
      voiceLoosens(
        base,
        voiceWith({ provider: 'elevenlabs', elevenlabs: { voiceId: VOICE, dailyChars: 10_000, model: 'eleven_v3' } }),
      ),
    ).toEqual(['spoken lines now use the ElevenLabs model eleven_v3']);
    expect(
      voiceLoosens(base, voiceWith({ provider: 'elevenlabs', elevenlabs: { voiceId: VOICE, dailyChars: 5_000 } })),
    ).toEqual([]);
  });
});
