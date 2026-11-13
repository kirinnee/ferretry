/**
 * WHICH FAILURES OF THE DIRECTORY READ ARE WORTH ASKING AGAIN.
 *
 * The adapter is the only code that saw the failure, so it is the one that marks it: a connection that
 * failed, a timeout, a 5xx and a 429 change by themselves; everything else is an answer and is final.
 * Fake fetcher, no network.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { HostedRelayDirectory } from '../../../src/adapters/relay/hosted-relay-directory.ts';
import { isTransientAdvertisement } from '../../../src/lib/relay/index.ts';

const answering = (response: () => Response | Promise<Response>) =>
  new HostedRelayDirectory('https://relay.example', { fetcher: async () => await response() });

describe('the hosted relay directory’s transient failures', () => {
  it('should mark an unreachable directory and a timeout as transient', async () => {
    const unreachable = new HostedRelayDirectory('https://relay.example', {
      fetcher: async () => await Promise.reject(new Error('Unable to connect.')),
    });
    should(isTransientAdvertisement(await unreachable.read())).be.true();
    // Rejects on abort, so the case is the adapter's classification of a timeout, not Bun's fetch.
    const aborting = new HostedRelayDirectory('https://relay.example', {
      fetcher: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
        }),
      timeoutMs: 20,
    });
    should(isTransientAdvertisement(await aborting.read())).be.true();
  });

  it('should mark 5xx and 429 as transient', async () => {
    for (const status of [500, 502, 503, 504, 429]) {
      const answer = await answering(() => new Response('later', { status })).read();
      should(isTransientAdvertisement(answer)).be.true();
      should(answer).match({ kind: 'undetermined', reason: new RegExp(`answered ${String(status)}`, 'u') });
    }
  });

  it('should carry a Retry-After of whole seconds on a 429 or 5xx, and ignore any other spelling', async () => {
    const withHeader = async (status: number, value?: string) =>
      await answering(
        () => new Response('later', { status, headers: value === undefined ? {} : { 'retry-after': value } }),
      ).read();

    should(await withHeader(429, '12')).match({ transient: true, retryAfterMs: 12_000 });
    should(await withHeader(503, '0')).match({ transient: true, retryAfterMs: 0 });
    should(await withHeader(503, 'Wed, 21 Oct 2026 07:28:00 GMT')).not.have.property('retryAfterMs');
    should(await withHeader(503, '-5')).not.have.property('retryAfterMs');
    should(await withHeader(503)).not.have.property('retryAfterMs');
    // Any other 4xx is an answer, so its header is not read at all.
    should(await withHeader(404, '12')).not.have.property('transient');
  });

  it('should not mark a definitive refusal, a bad document, a disabled relay or a missing origin', async () => {
    const definitive = [
      await answering(() => new Response('no', { status: 404 })).read(),
      await answering(() => new Response('no', { status: 403 })).read(),
      await answering(() => new Response('<html>hello</html>', { status: 200 })).read(),
      await answering(() => Response.json({ version: 9, relayUrl: 'https://relay.example' })).read(),
      await answering(() => Response.json({ version: 1, relayUrl: null })).read(),
      await new HostedRelayDirectory(undefined).read(),
      await new HostedRelayDirectory('http://relay.example').read(),
    ];

    for (const answer of definitive) should(isTransientAdvertisement(answer)).be.false();
  });

  it('should not mark an available relay', async () => {
    const answer = await answering(() => Response.json({ version: 1, relayUrl: 'https://relay.example' })).read();
    should(answer).deepEqual({ kind: 'available', relayUrl: 'https://relay.example' });
  });
});
