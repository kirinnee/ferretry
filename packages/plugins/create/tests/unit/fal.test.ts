import { describe, expect, test } from 'bun:test';
import type { OutboundSecretOutcome, SecretsPort } from '@ferretry/kernel/contract';
import { isFailure, readPrice, runImage } from '../../daemon/lib/fal.ts';

/** A kernel that answers every send with one outcome, and remembers what it was asked. */
function kernelAnswering(outcome: OutboundSecretOutcome) {
  const sent: { name: string; url: string; placement: unknown }[] = [];
  const secrets = {
    resolve: async () => ({ refused: 'unknown' as const }),
    send: async (name: string, request: { url: string }, placement?: unknown) => {
      sent.push({ name, url: request.url, placement });
      return outcome;
    },
  } as unknown as SecretsPort;
  return { secrets, sent };
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
