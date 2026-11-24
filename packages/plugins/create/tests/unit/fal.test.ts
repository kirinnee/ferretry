import { describe, expect, test } from 'bun:test';
import type { OutboundSecretOutcome, SecretsPort } from '@ferretry/kernel/contract';
import { ELEVENLABS, runSpeech } from '../../daemon/lib/elevenlabs.ts';
import { isFailure, readPrice, runImage, runMusic, runSfx } from '../../daemon/lib/fal.ts';

/** A kernel that answers every send with one outcome, and remembers what it was asked. */
function kernelAnswering(outcome: OutboundSecretOutcome) {
  const sent: { name: string; url: string; placement: unknown }[] = [];
  const bodies: string[] = [];
  const secrets = {
    resolve: async () => ({ refused: 'unknown' as const }),
    send: async (name: string, request: { url: string; body?: string }, placement?: unknown) => {
      sent.push({ name, url: request.url, placement });
      bodies.push(request.body ?? '');
      return outcome;
    },
  } as unknown as SecretsPort;
  return { secrets, sent, bodies };
}

const sentenceOf = async (outcome: OutboundSecretOutcome): Promise<string> => {
  const made = await runImage(kernelAnswering(outcome).secrets, 'fal-ai/flux/schnell', 'a fox', 'square');
  if (!isFailure(made)) throw new Error('expected a failure');
  return made.sentence;
};

describe('what a run says when fal does not give a picture', () => {
  test('every way the kernel can fail becomes one sentence, and a key problem a code of its own', async () => {
    expect(await sentenceOf({ kind: 'refused', refused: 'not_configured' })).toContain('fy secret set FAL_KEY');
    expect(await sentenceOf({ kind: 'refused', refused: 'unknown' })).toContain('fy secret set FAL_KEY');
    expect(await sentenceOf({ kind: 'refused', refused: 'destination' })).toContain('refused before it was sent');
    expect(await sentenceOf({ kind: 'refused', refused: 'placement' })).toContain('refused before it was sent');
    expect(await sentenceOf({ kind: 'vault_damaged' })).toContain('secret store could not be opened');
    expect(await sentenceOf({ kind: 'status', status: 401 })).toContain('fal refused the key');
    expect(await sentenceOf({ kind: 'status', status: 403 })).toContain('fal refused the key');
    expect(await sentenceOf({ kind: 'status', status: 429 })).toContain('too many requests');
    expect(await sentenceOf({ kind: 'status', status: 502 })).toBe('fal answered 502');
    expect(await sentenceOf({ kind: 'timeout' })).toContain('did not answer in time');
    expect(await sentenceOf({ kind: 'network' })).toContain('could not be reached');
    expect(await sentenceOf({ kind: 'too_large' })).toContain('could not read');
    expect(await sentenceOf({ kind: 'unreadable' })).toContain('could not read');
  });

  test('an answer with no picture in it is a failure, not a link to nothing', async () => {
    expect(await sentenceOf({ kind: 'completion', status: 200, payload: { images: [] } })).toContain('made no picture');
    expect(await sentenceOf({ kind: 'completion', status: 200, payload: 'nope' })).toContain('made no picture');
  });

  test('a run goes to fal.run with the key placed as `Key`, and the first picture’s link comes back', async () => {
    const { secrets, sent } = kernelAnswering({
      kind: 'completion',
      status: 200,
      payload: { images: [{ url: 'https://v3.fal.media/a.jpg' }, { url: 'https://v3.fal.media/b.jpg' }] },
    });
    expect(await runImage(secrets, 'fal-ai/flux/dev', 'a fox', 'square')).toEqual({
      url: 'https://v3.fal.media/a.jpg',
    });
    expect(sent).toEqual([
      {
        name: 'FAL_KEY',
        url: 'https://fal.run/fal-ai/flux/dev',
        placement: { header: 'authorization', scheme: 'Key' },
      },
    ]);
  });
});

describe('reading fal’s price', () => {
  const read = async (outcome: OutboundSecretOutcome) =>
    await readPrice(kernelAnswering(outcome).secrets, 'fal-ai/flux/dev');

  test('the rate for the endpoint asked about', async () => {
    const rate = await read({
      kind: 'completion',
      status: 200,
      payload: {
        prices: [
          { endpoint_id: 'fal-ai/other', unit_price: 9, unit: 'image' },
          { endpoint_id: 'fal-ai/flux/dev', unit_price: 0.025, unit: 'megapixels' },
        ],
      },
    });
    expect(rate).toEqual({ unitPrice: 0.025, unit: 'megapixels' });
  });

  test('the price goes to api.fal.ai, with the endpoint id in the query', async () => {
    const { secrets, sent } = kernelAnswering({ kind: 'status', status: 500 });
    await readPrice(secrets, 'fal-ai/flux-pro/v1.1');
    expect(sent[0]?.url).toBe('https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai%2Fflux-pro%2Fv1.1');
  });

  test('no key and a refused key are the caller’s to hear; anything else means "ask the table"', async () => {
    expect(await read({ kind: 'refused', refused: 'not_configured' })).toMatchObject({ code: 'no_key' });
    expect(await read({ kind: 'status', status: 401 })).toMatchObject({ code: 'rejected' });
    expect(await read({ kind: 'status', status: 500 })).toBeUndefined();
    expect(await read({ kind: 'timeout' })).toBeUndefined();
    expect(await read({ kind: 'network' })).toBeUndefined();
  });

  test('an answer that does not name the endpoint, or is not a price list, is no rate', async () => {
    expect(await read({ kind: 'completion', status: 200, payload: { prices: [] } })).toBeUndefined();
    expect(await read({ kind: 'completion', status: 200, payload: { prices: 'free' } })).toBeUndefined();
    expect(
      await read({
        kind: 'completion',
        status: 200,
        payload: { prices: [{ endpoint_id: 'fal-ai/flux/dev', unit_price: -1, unit: 'image' }] },
      }),
    ).toBeUndefined();
  });
});

describe('a sound run on fal', () => {
  const link = { kind: 'completion', status: 200, payload: { audio: { url: 'https://v3.fal.media/s.mp3' } } } as const;

  test('a sound effect goes to its own endpoint with the length and the format, and the link comes back', async () => {
    const { secrets, sent, bodies } = kernelAnswering(link);
    expect(await runSfx(secrets, 'a bell', 4)).toEqual({ url: 'https://v3.fal.media/s.mp3' });
    expect(sent[0]).toMatchObject({
      name: 'FAL_KEY',
      url: 'https://fal.run/fal-ai/elevenlabs/sound-effects/v2',
      placement: { header: 'authorization', scheme: 'Key' },
    });
    expect(JSON.parse(bodies[0]!)).toEqual({
      text: 'a bell',
      duration_seconds: 4,
      output_format: 'mp3_44100_64',
      enable_safety_checker: true,
    });
  });

  test('music goes to its own endpoint, with the length in milliseconds', async () => {
    const { secrets, sent, bodies } = kernelAnswering(link);
    expect(await runMusic(secrets, 'a song', 12, true)).toEqual({ url: 'https://v3.fal.media/s.mp3' });
    expect(sent[0]!.url).toBe('https://fal.run/fal-ai/elevenlabs/music');
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      prompt: 'a song',
      music_length_ms: 12_000,
      force_instrumental: true,
    });
  });

  test('an answer with no sound in it is a failure, not a link to nothing', async () => {
    for (const payload of [{}, { audio: {} }, 'nope', { images: [{ url: 'https://v3.fal.media/a.jpg' }] }]) {
      const made = await runSfx(kernelAnswering({ kind: 'completion', status: 200, payload }).secrets, 'a bell', 4);
      expect(isFailure(made) && made.sentence).toContain('made no sound');
    }
  });

  test('a missing key and a dropped line are said as for a picture', async () => {
    const none = await runMusic(kernelAnswering({ kind: 'refused', refused: 'not_configured' }).secrets, 'x', 5, false);
    expect(isFailure(none) && none.sentence).toContain('fy secret set FAL_KEY');
    const slow = await runSfx(kernelAnswering({ kind: 'timeout' }).secrets, 'x', 5);
    expect(isFailure(slow) && slow.noCharge).toBeUndefined();
  });
});

describe('ElevenLabs speech through the Vault', () => {
  const speech = async (outcome: OutboundSecretOutcome) => {
    const kernel = kernelAnswering(outcome);
    return { made: await runSpeech(kernel.secrets, 'voice0123456789', 'eleven_flash_v2_5', 'hi'), sent: kernel.sent };
  };

  test('the key is placed as xi-api-key, on the one host, at the JSON endpoint', async () => {
    const { made, sent } = await speech({ kind: 'completion', status: 200, payload: { audio_base64: 'SUQz' } });
    expect(made).toEqual({ bytes: new Uint8Array([0x49, 0x44, 0x33]) });
    expect(sent[0]).toMatchObject({
      name: 'ELEVENLABS_API_KEY',
      url: 'https://api.elevenlabs.io/v1/text-to-speech/voice0123456789/with-timestamps?output_format=mp3_44100_64',
      placement: { header: 'xi-api-key' },
    });
  });

  test('every failure names ElevenLabs, and a missing key says how to add one', async () => {
    const sentence = async (outcome: OutboundSecretOutcome) => {
      const { made } = await speech(outcome);
      if (!isFailure(made)) throw new Error('expected a failure');
      return made.sentence;
    };
    expect(await sentence({ kind: 'refused', refused: 'not_configured' })).toBe(ELEVENLABS.noKey);
    expect(ELEVENLABS.noKey).toContain('fy secret set ELEVENLABS_API_KEY');
    expect(await sentence({ kind: 'status', status: 401 })).toContain('ElevenLabs refused the key');
    expect(await sentence({ kind: 'status', status: 429 })).toContain('ElevenLabs says too many requests');
    expect(await sentence({ kind: 'status', status: 500 })).toBe('ElevenLabs answered 500');
    expect(await sentence({ kind: 'timeout' })).toContain('ElevenLabs did not answer in time');
    expect(await sentence({ kind: 'unreadable' })).toContain('ElevenLabs answered something Create could not read');
  });

  test('audio that is not base64, is empty, or is too long to keep is no speech', async () => {
    for (const audio_base64 of ['', 'not base64!', 'AAAA'.repeat(1100 * 1024)]) {
      const { made } = await speech({ kind: 'completion', status: 200, payload: { audio_base64 } });
      expect(isFailure(made)).toBe(true);
    }
  });
});
