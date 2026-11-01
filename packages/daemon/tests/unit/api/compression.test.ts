import { describe, it } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { fromBase64Url } from '@ferretry/relay';
import should from 'should';
import { NodeGzip } from '../../../src/adapters/api/node-gzip.ts';
import {
  acceptsGzip,
  ApiDispatcher,
  type ApiRoute,
  ApiRouter,
  COMPRESS_MIN_BYTES,
  conditional,
  entityTag,
  jsonResponse,
  NO_GOVERNED_ROUTES_GUARD,
  type ResponseCompressor,
} from '../../../src/lib/api/index.ts';
import { tunnelApiRequest, tunnelResponseMessages } from '../../../src/lib/relay/tunnel.ts';
import { request } from './support.ts';

const credentials = { admin: 'admin-secret', warden: 'warden-secret', devices: { has: () => true } };
const ADMIN = { authorization: 'Bearer admin-secret' };
const BIG = { rows: Array.from({ length: 600 }, (_, index) => ({ id: index, name: `session number ${index}` })) };
const BIG_TEXT = JSON.stringify(BIG);

/** A compressor that counts what it was asked, so "never compressed" is proved by zero calls, not by an absent header. */
function countingCompressor(): ResponseCompressor & { readonly calls: string[] } {
  const calls: string[] = [];
  const real = new NodeGzip();
  return {
    calls,
    gzip: async text => {
      calls.push(text);
      return await real.gzip(text);
    },
  };
}

const route = (path: string, handle: ApiRoute['handle'], flags: Partial<ApiRoute> = {}, method = 'GET'): ApiRoute => ({
  method,
  path,
  minimum: 'none',
  caller: 'any',
  handle,
  ...flags,
});

function dispatcherFor(compressor: ResponseCompressor | undefined, ...routes: readonly ApiRoute[]): ApiDispatcher {
  return new ApiDispatcher(
    new ApiRouter(routes),
    credentials,
    NO_GOVERNED_ROUTES_GUARD,
    undefined,
    undefined,
    undefined,
    compressor,
  );
}

/** An audited route: it opted in, so what these tests vary is everything else about the answer. */
const big = (path: string, flags: Partial<ApiRoute> = {}, method = 'GET'): ApiRoute =>
  route(path, async () => jsonResponse(BIG), { compress: true, ...flags }, method);

describe('which Accept-Encoding admits gzip', () => {
  it('should admit a named gzip and a wildcard, and refuse everything else', () => {
    should(acceptsGzip('gzip')).be.true();
    should(acceptsGzip('br, gzip;q=0.8')).be.true();
    should(acceptsGzip('GZIP')).be.true();
    should(acceptsGzip('*')).be.true();
    should(acceptsGzip(undefined)).be.false();
    should(acceptsGzip('')).be.false();
    should(acceptsGzip('identity')).be.false();
    should(acceptsGzip('br, deflate')).be.false();
  });

  it('should honour q=0 and a name that overrides the wildcard', () => {
    should(acceptsGzip('gzip;q=0')).be.false();
    should(acceptsGzip('*;q=0')).be.false();
    should(acceptsGzip('gzip;q=0, *')).be.false();
    should(acceptsGzip('identity, gzip;q=0.1')).be.true();
  });
});

describe('response compression at the dispatcher', () => {
  it('should gzip a large GET answer for a caller that accepts it, and keep the body the route wrote', async () => {
    // Arrange
    const compressor = countingCompressor();
    const dispatcher = dispatcherFor(compressor, big('/v1/list'));

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/list', headers: { ...ADMIN, 'accept-encoding': 'gzip, deflate' } }),
    );

    // Assert — the decoded bytes are the plain answer, and the plain `body` is still there for the tag and the audit.
    should(response.status).equal(200);
    should(response.gzip).not.be.undefined();
    should(Buffer.from(gunzipSync(response.gzip ?? new Uint8Array())).toString('utf8')).equal(BIG_TEXT);
    should(response.body).equal(BIG_TEXT);
    should(response.headers.get('vary')).equal('Accept-Encoding');
    should((response.gzip?.byteLength ?? 0) * 4).be.below(BIG_TEXT.length);
  });

  it('should answer a caller that did not ask in plain text, and still say the answer varies', async () => {
    // Arrange
    const compressor = countingCompressor();
    const dispatcher = dispatcherFor(compressor, big('/v1/list'));

    // Act
    const response = await dispatcher.dispatch(request({ path: '/v1/list', headers: ADMIN }));

    // Assert
    should(response.gzip).be.undefined();
    should(response.body).equal(BIG_TEXT);
    should(response.headers.get('vary')).equal('Accept-Encoding');
    should(compressor.calls).have.length(0);
  });

  it('should append to a Vary the route already set rather than replace it', async () => {
    // Arrange
    const dispatcher = dispatcherFor(
      countingCompressor(),
      route(
        '/v1/list',
        async () => ({
          ...jsonResponse(BIG),
          headers: new Map([...jsonResponse(BIG).headers, ['vary', 'Origin']]),
        }),
        { compress: true },
      ),
    );

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/list', headers: { ...ADMIN, 'accept-encoding': 'gzip' } }),
    );

    // Assert
    should(response.headers.get('vary')).equal('Origin, Accept-Encoding');
  });

  it('should leave a small answer alone, however it is asked for', async () => {
    // Arrange
    const compressor = countingCompressor();
    const dispatcher = dispatcherFor(
      compressor,
      route('/v1/small', async () => jsonResponse({ ok: true })),
    );

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/small', headers: { ...ADMIN, 'accept-encoding': 'gzip' } }),
    );

    // Assert
    should(BIG_TEXT.length).be.above(COMPRESS_MIN_BYTES);
    should(response.gzip).be.undefined();
    should(response.headers.get('vary')).be.undefined();
    should(compressor.calls).have.length(0);
  });

  it('should never compress an answer whose route has not opted in, however large and however asked', async () => {
    // Arrange — a route nobody audited, which is what every route added later is until its author says otherwise.
    const compressor = countingCompressor();
    const dispatcher = dispatcherFor(
      compressor,
      route('/v1/unaudited', async () => jsonResponse(BIG)),
    );

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/unaudited', headers: { ...ADMIN, 'accept-encoding': 'gzip' } }),
    );

    // Assert — not merely unsent: the compressor was never handed the text.
    should(response.status).equal(200);
    should(response.gzip).be.undefined();
    should(response.headers.get('vary')).be.undefined();
    should(compressor.calls).have.length(0);
  });

  it('should never compress anything but a GET', async () => {
    // Arrange
    const compressor = countingCompressor();
    const dispatcher = dispatcherFor(compressor, big('/v1/pair/code', {}, 'POST'));

    // Act
    const response = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', headers: { ...ADMIN, 'accept-encoding': 'gzip' } }),
    );

    // Assert
    should(response.gzip).be.undefined();
    should(compressor.calls).have.length(0);
  });

  it('should never compress an error, a bodyless 304 or a non-JSON answer', async () => {
    // Arrange
    const compressor = countingCompressor();
    const dispatcher = dispatcherFor(
      compressor,
      route('/v1/failing', async () => jsonResponse(BIG, 500)),
      route('/v1/cached', async () => conditional(jsonResponse(BIG), entityTag(BIG_TEXT))),
      route('/v1/text', async () => ({
        status: 200,
        headers: new Map([['content-type', 'text/plain; charset=utf-8']]),
        body: BIG_TEXT,
      })),
    );
    const accept = { ...ADMIN, 'accept-encoding': 'gzip' };

    // Act
    const failing = await dispatcher.dispatch(request({ path: '/v1/failing', headers: accept }));
    const cached = await dispatcher.dispatch(request({ path: '/v1/cached', headers: accept }));
    const text = await dispatcher.dispatch(request({ path: '/v1/text', headers: accept }));

    // Assert
    should(failing.gzip).be.undefined();
    should(cached.status).equal(304);
    should(cached.gzip).be.undefined();
    should(text.gzip).be.undefined();
    should(compressor.calls).have.length(0);
  });

  it('should send the same tag whether or not the answer is compressed', async () => {
    // Arrange
    const dispatcher = dispatcherFor(
      countingCompressor(),
      route('/v1/list', async context => conditional(jsonResponse(BIG), context.request.headers.get('if-none-match'))),
    );

    // Act
    const plain = await dispatcher.dispatch(request({ path: '/v1/list', headers: ADMIN }));
    const gzipped = await dispatcher.dispatch(
      request({ path: '/v1/list', headers: { ...ADMIN, 'accept-encoding': 'gzip' } }),
    );

    // Assert — a client that learned the tag over one encoding may revalidate over the other.
    should(plain.headers.get('etag')).match(/^"[A-Za-z0-9_-]+"$/u);
    should(gzipped.headers.get('etag')).equal(plain.headers.get('etag'));
  });

  it('should serve plain text where no compressor is wired', async () => {
    // Arrange
    const dispatcher = dispatcherFor(undefined, big('/v1/list'));

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/list', headers: { ...ADMIN, 'accept-encoding': 'gzip' } }),
    );

    // Assert
    should(response.gzip).be.undefined();
    should(response.headers.get('vary')).be.undefined();
  });
});

describe('a relayed answer is compressed only for a client that asked', () => {
  const DEVICE = { deviceId: `fy_device_id_${'a'.repeat(22)}`, appSession: 'AQEBAQEBAQEBAQEBAQEBAQ' } as const;

  /** A relayed `req` through the tunnel's own request constructor and the dispatcher, then back out as `res` records. */
  async function relayed(headers: Record<string, string> | undefined) {
    const compressor = countingCompressor();
    const dispatcher = dispatcherFor(compressor, big('/v1/list'));
    const asked = tunnelApiRequest(
      { method: 'GET', path: '/v1/list', ...(headers === undefined ? {} : { headers }) },
      DEVICE,
      's1',
    );
    const response = await dispatcher.dispatch(asked);
    const [message, ...rest] = tunnelResponseMessages(1, response);
    return {
      compressor,
      message: message as { readonly headers?: Record<string, string>; readonly body?: string },
      rest,
    };
  }

  it('should send an older client that never asks for an encoding the plain body and no encoding header', async () => {
    // Act — an app that predates compression sends no accept-encoding at all.
    const { compressor, message, rest } = await relayed(undefined);

    // Assert
    should(rest).have.length(0);
    should(message.body).equal(BIG_TEXT);
    should(message.headers?.['content-encoding']).be.undefined();
    should(message.headers?.['content-transfer-encoding']).be.undefined();
    should(compressor.calls).have.length(0);
  });

  it('should send the plain body to a client that refuses gzip, and to one that asks for nothing it can name', async () => {
    for (const refusing of ['identity', 'gzip;q=0', 'br, deflate']) {
      // Act
      const { compressor, message } = await relayed({ 'accept-encoding': refusing });

      // Assert
      should(message.body).equal(BIG_TEXT);
      should(message.headers?.['content-encoding']).be.undefined();
      should(compressor.calls).have.length(0);
    }
  });

  it('should send gzip as base64url under the two headers to a client that asks, and it decodes to the plain body', async () => {
    // Act
    const { message, rest } = await relayed({ 'accept-encoding': 'gzip' });

    // Assert
    should(rest).have.length(0);
    should(message.headers?.['content-encoding']).equal('gzip');
    should(message.headers?.['content-transfer-encoding']).equal('base64url');
    should(gunzipSync(fromBase64Url(message.body ?? '') ?? new Uint8Array()).toString('utf8')).equal(BIG_TEXT);
  });
});

describe('the gzip codec adapter', () => {
  it('should round-trip text, multi-byte characters included', async () => {
    // Arrange
    const text = `${BIG_TEXT}é😀`;

    // Act
    const bytes = await new NodeGzip().gzip(text);

    // Assert
    should(gunzipSync(bytes).toString('utf8')).equal(text);
  });
});
