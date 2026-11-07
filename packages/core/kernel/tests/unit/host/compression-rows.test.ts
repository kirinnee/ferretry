/** R512 and R565 at the dispatcher's compression policy and the session's stream records. */
import { describe, expect, test } from 'bun:test';
import type { ApiRequest, ApiResponse } from '../../../contract/http.ts';
import { headersFrom, jsonResponse } from '../../../contract/http.ts';
import { NodeGzip } from '../../../host/adapters/node-gzip.ts';
import { COMPRESS_MIN_BYTES, compressed } from '../../../host/compression.ts';
import { fixture, pairedDevice, TestClient } from '../host-session/harness.ts';
import { relayCrypto } from '../host-session/identities.ts';
import { request } from './fixtures.ts';
import type { SocketDownstream, SocketHandler } from '../../../contract/socket.ts';

const gzip = new NodeGzip();
const big = (headers: Record<string, string> = {}): ApiResponse => {
  const answer = jsonResponse({ items: 'x'.repeat(COMPRESS_MIN_BYTES) });
  return { ...answer, headers: new Map([...answer.headers, ...Object.entries(headers)]) };
};
const asking = (encoding: string | null): ApiRequest => ({
  ...request('GET', '/v1/sessions'),
  headers: headersFrom(encoding === null ? {} : { 'accept-encoding': encoding }),
});

describe('R512 a response that varies by encoding carries Vary: Accept-Encoding', () => {
  test('R512 an eligible answer carries Vary whether or not this caller asked for gzip', async () => {
    for (const encoding of ['gzip', 'identity', null, 'br']) {
      const answered = await compressed(asking(encoding), big(), gzip, true);
      expect(answered.response.headers.get('vary')).toBe('Accept-Encoding');
      expect(answered.gzip !== undefined).toBe(encoding === 'gzip');
    }
  });

  test('R512 Accept-Encoding is added to an existing Vary once, and an answer that never varies carries none', async () => {
    const withOrigin = await compressed(asking('gzip'), big({ vary: 'Origin' }), gzip, true);
    expect(withOrigin.response.headers.get('vary')).toBe('Origin, Accept-Encoding');
    for (const existing of ['accept-encoding', 'Origin, Accept-Encoding', '*']) {
      const again = await compressed(asking('gzip'), big({ vary: existing }), gzip, true);
      expect(again.response.headers.get('vary')).toBe(existing);
    }
    // Not opted in, not eligible: nothing varies by encoding, so nothing says so.
    expect((await compressed(asking('gzip'), big(), gzip, false)).response.headers.get('vary')).toBeUndefined();
    expect(
      (await compressed(asking('gzip'), jsonResponse({ small: 1 }), gzip, true)).response.headers.get('vary'),
    ).toBeUndefined();
  });
});

interface Handler extends SocketHandler {
  downstream?: SocketDownstream;
}

describe('R565 no stream is compressed', () => {
  test('R565 a stream answer is never offered to the compressor, and the records a stream carries keep their plain text and length', async () => {
    const fx = await fixture();
    const handler: Handler = { open: async () => {}, fromClient: () => {}, close: () => {} };
    fx.sockets = {
      upgrade: async () => ({
        outcome: 'accepted',
        attach: async downstream => {
          handler.downstream = downstream;
          return handler;
        },
      }),
      reauthorize: () => true,
    };
    const device = await pairedDevice(fx.device);
    const client = TestClient.open(fx);
    await client.handshake(fx.daemonId);
    await client.auth(device, { path: '/v1/events' }, 'stream');
    // Two frames of the same length: one the most compressible text there is, one that is not compressible.
    const repetitive = 'a'.repeat(20_000);
    const random = Array.from(relayCrypto.randomBytes(20_000), byte => String.fromCharCode(97 + (byte % 26))).join('');
    const before = client.wire.length;
    handler.downstream?.send(repetitive);
    handler.downstream?.send(random);
    await client.pump();
    const data = client.records.filter(record => record['t'] === 'data');
    expect(data).toEqual([
      { t: 'data', text: repetitive },
      { t: 'data', text: random },
    ]);
    // No compress-then-encrypt size channel: both sealed frames are the same size.
    const sizes = client.wire.slice(before).map(bytes => bytes.length);
    expect(sizes).toHaveLength(2);
    expect(sizes[0]).toBe(sizes[1] as number);
    // And the compression policy itself: a stream route is never opted in, so a socket upgrade is not a GET answer.
    const gzipped = await compressed(asking('gzip'), { ...big(), status: 101 }, gzip, true);
    expect(gzipped.gzip).toBeUndefined();
  });
});
