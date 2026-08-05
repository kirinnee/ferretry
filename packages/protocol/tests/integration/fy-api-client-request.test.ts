import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import {
  FetchHttpTransport,
  FY_REQUEST_TIMEOUT_MS,
  FyApiClient,
  FyHttpError,
  FyTransportError,
} from '../../src/adapters/fy-api-client.ts';
import type { FyClientOptions } from '../../src/lib/client.ts';
import { BASE_CLIENT_OPTIONS as BASE_OPTIONS, connectClient as connect, headersOf } from './client-harness.ts';
import { captureError, emptyResponse, jsonResponse, QueuedHttpTransport, textResponse } from './fakes.ts';

describe('FyApiClient construction and generic requests', () => {
  it('should expose the exact public instance method set and connect separately', async () => {
    // Arrange
    const expected = [
      'analytics',
      'answer',
      'attachTarget',
      'cgroupConfig',
      'events',
      'get',
      'health',
      'history',
      'interrupt',
      'list',
      'logs',
      'migrate',
      'projects',
      'pwaConfig',
      'remove',
      'rename',
      'request',
      'resume',
      'runtime',
      'scratchPlan',
      'scratchSweep',
      'send',
      'sessionSkills',
      'signal',
      'snapshot',
      'start',
      'stop',
      'stream',
      'suggestNames',
      'updateCgroupConfig',
      'updatePwaConfig',
      'updateWardenConfig',
      'upload',
      'usage',
      'wardenConfig',
      'wardenRun',
      'wardenStatus',
    ];

    // Act
    const methods = Object.getOwnPropertyNames(FyApiClient.prototype)
      .filter(name => name !== 'constructor')
      .sort();
    const client = await connect(new QueuedHttpTransport());

    // Assert
    should(methods).deepEqual(expected);
    should(client).be.instanceof(FyApiClient);
    should(typeof FyApiClient.connect).equal('function');
  });

  it('should normalize the base URL and merge headers while forcing credentials and versions', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(textResponse('accepted'));
    const client = await connect(transport, {
      headers: { authorization: 'Basic base', 'x-base': 'base', 'x-fy-version': '0.0.1' },
    });

    // Act
    const actual = await client.request('/probe', z.string(), {
      headers: {
        authorization: 'Basic call',
        'x-base': 'call',
        'x-call': 'present',
        'x-fy-request-id': '  supplied-id  ',
        'x-fy-version': '0.0.2',
      },
    });

    // Assert
    should(actual).equal('accepted');
    should(transport.calls[0]?.url).equal('http://daemon.test/api/probe');
    should(headersOf(transport).get('authorization')).equal('Bearer secret-token');
    should(headersOf(transport).get('x-base')).equal('call');
    should(headersOf(transport).get('x-call')).equal('present');
    should(headersOf(transport).get('x-fy-request-id')).equal('supplied-id');
    should(headersOf(transport).get('x-fy-version')).equal('1.2.3');
  });

  it('should use the production UUID request-ID collaborator by default', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse('ok'));
    const client = await FyApiClient.connect({ ...BASE_OPTIONS, transport });

    // Act
    const actual = await client.request('/uuid', z.string());

    // Assert
    should(actual).equal('ok');
    should(headersOf(transport).get('x-fy-request-id')).match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('should reject invalid constructor and request inputs before transport I/O', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const invalidOptions: FyClientOptions[] = [
      { ...BASE_OPTIONS, baseUrl: 'file:///tmp/fyd', transport },
      { ...BASE_OPTIONS, baseUrl: 'http://user:pass@daemon.test', transport },
      { ...BASE_OPTIONS, baseUrl: 'http://daemon.test?query=yes', transport },
      { ...BASE_OPTIONS, baseUrl: 'http://daemon.test#fragment', transport },
      { ...BASE_OPTIONS, token: '   ', transport },
      { ...BASE_OPTIONS, version: 'v1.2.3', transport },
    ];

    // Act
    const constructorErrors = await Promise.all(
      invalidOptions.map(options => captureError(() => FyApiClient.connect(options))),
    );
    const client = await connect(transport);
    const invalidRequestErrors = [
      await captureError(() => client.request('   ', z.string())),
      await captureError(() => client.request('/probe', z.string(), {}, 0)),
    ];
    const blankIdClient = await connect(transport, { requestId: () => '   ' });
    const requestIdError = await captureError(() => blankIdClient.request('/probe', z.string()));

    // Assert
    for (const error of [...constructorErrors, ...invalidRequestErrors, requestIdError]) {
      should(error instanceof Error).be.true();
    }
    should(transport.calls).have.length(0);
  });

  it('should parse JSON, text, and 204 responses and reject malformed successful payloads', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      jsonResponse({ value: 7 }),
      textResponse('plain text', { headers: { 'content-type': 'text/plain' } }),
      emptyResponse(),
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      jsonResponse({ value: 'wrong' }),
    );
    const client = await connect(transport);
    const objectSchema = z.object({ value: z.number() });

    // Act
    const json = await client.request('/json', objectSchema);
    const text = await client.request('/text', z.string());
    const empty = await client.request('/empty', z.undefined());
    const malformedJsonError = await captureError(() => client.request('/malformed-json', z.unknown()));
    const malformedValueError = await captureError(() => client.request('/malformed-value', objectSchema));

    // Assert
    should(json).deepEqual({ value: 7 });
    should(text).equal('plain text');
    should(empty).be.undefined();
    should(malformedJsonError instanceof SyntaxError).be.true();
    should(malformedValueError instanceof z.ZodError).be.true();
  });
});

describe('FyApiClient transport and HTTP failures', () => {
  it('should retry transport failures three times with a stable request ID and 250/500 ms sleeps', async () => {
    // Arrange
    const cause = new Error('connection refused');
    const transport = new QueuedHttpTransport({ throws: cause }, { throws: cause }, { throws: cause });
    const sleeps: number[] = [];
    let generatedIds = 0;
    const client = await connect(transport, {
      requestId: () => {
        generatedIds += 1;
        return 'stable-id';
      },
      sleep: async milliseconds => {
        sleeps.push(milliseconds);
      },
    });

    // Act
    const error = await captureError(() => client.request('/retry', z.string()));

    // Assert
    should(error instanceof FyTransportError).be.true();
    const typed = error as FyTransportError;
    should(typed.path).equal('/retry');
    should(typed.timedOut).be.false();
    should(typed.cause).equal(cause);
    should(typed.message).containEql('http://daemon.test/api');
    should(typed.message).containEql('connection refused');
    should(transport.calls).have.length(3);
    should(generatedIds).equal(1);
    should(sleeps).deepEqual([250, 500]);
    should(transport.calls.map((_, index) => headersOf(transport, index).get('x-fy-request-id'))).deepEqual([
      'stable-id',
      'stable-id',
      'stable-id',
    ]);
    for (const call of transport.calls) should(call.init.signal instanceof AbortSignal).be.true();
  });

  it('should exercise the production sleep collaborator without a wall-clock delay', async () => {
    // Arrange
    const transport = new QueuedHttpTransport({ throws: new Error('once') }, jsonResponse('recovered'));
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, milliseconds?: number) => {
      delays.push(milliseconds ?? 0);
      callback();
      return 0;
    }) as unknown as typeof setTimeout;

    try {
      const client = await FyApiClient.connect({ ...BASE_OPTIONS, transport, requestId: () => 'default-sleep' });

      // Act
      const actual = await client.request('/default-sleep', z.string());

      // Assert
      should(actual).equal('recovered');
      should(delays).deepEqual([250]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('should classify deadline expiry as timed out and stop retrying', async () => {
    // Arrange
    const timeout = new Error('deadline expired');
    timeout.name = 'TimeoutError';
    const transport = new QueuedHttpTransport({ throws: timeout });
    const sleeps: number[] = [];
    const client = await connect(transport, {
      sleep: async milliseconds => {
        sleeps.push(milliseconds);
      },
    });

    // Act
    const error = await captureError(() => client.request('/slow', z.string(), {}, 1_000));

    // Assert
    should(error instanceof FyTransportError).be.true();
    const typed = error as FyTransportError;
    should(typed.timedOut).be.true();
    should(typed.path).equal('/slow');
    should(typed.message).containEql('within 1s');
    should(typed.message).containEql('it may still have applied the request');
    should(typed.cause).equal(timeout);
    should(transport.calls).have.length(1);
    should(sleeps).deepEqual([]);
  });

  it('should classify caller cancellation separately and never retry it', async () => {
    // Arrange
    const controller = new AbortController();
    const abortError = new Error('caller stopped');
    abortError.name = 'AbortError';
    const transport = new QueuedHttpTransport(call => {
      should(call.init.signal).not.equal(controller.signal);
      controller.abort('cancelled by caller');
      should(call.init.signal?.aborted).be.true();
      throw abortError;
    });
    const sleeps: number[] = [];
    const client = await connect(transport, {
      sleep: async milliseconds => {
        sleeps.push(milliseconds);
      },
    });

    // Act
    const error = await captureError(() => client.request('/cancelled', z.string(), { signal: controller.signal }));

    // Assert
    should(error instanceof FyTransportError).be.true();
    const typed = error as FyTransportError;
    should(typed.timedOut).be.false();
    should(typed.path).equal('/cancelled');
    should(typed.message).containEql('cancelled');
    should(typed.cause).equal(abortError);
    should(transport.calls).have.length(1);
    should(sleeps).deepEqual([]);
  });

  it('should reject an already-aborted caller signal without transport I/O', async () => {
    // Arrange
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const transport = new QueuedHttpTransport();
    const client = await connect(transport);

    // Act
    const error = await captureError(() =>
      client.request('/cancelled-early', z.string(), { signal: controller.signal }),
    );

    // Assert
    should(error instanceof FyTransportError).be.true();
    const typed = error as FyTransportError;
    should(typed.timedOut).be.false();
    should(typed.path).equal('/cancelled-early');
    should(typed.message).containEql('cancelled');
    should(transport.calls).have.length(0);
  });

  it('should retain a non-Error transport cause without inventing detail text', async () => {
    // Arrange
    const transport = new QueuedHttpTransport({ throws: 'offline' }, { throws: 'offline' }, { throws: 'offline' });
    const client = await connect(transport);

    // Act
    const error = await captureError(() => client.request('/non-error', z.string()));

    // Assert
    should(error instanceof FyTransportError).be.true();
    const typed = error as FyTransportError;
    should(typed.cause).equal('offline');
    should(typed.message).equal('fyd is unavailable at http://daemon.test/api');
  });

  it('should expose structured and fallback HTTP errors without retrying', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      jsonResponse({ error: 'invalid request', code: 'invalid_input' }, { status: 400 }),
      new Response('{', { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'application/json' } }),
      jsonResponse({ message: 'not the API error schema' }, { status: 500 }),
    );
    const client = await connect(transport);

    // Act
    const structured = await captureError(() => client.request('/structured', z.string()));
    const statusText = await captureError(() => client.request('/status-text', z.string()));
    const generic = await captureError(() => client.request('/generic', z.string()));

    // Assert
    should(structured instanceof FyHttpError).be.true();
    should((structured as FyHttpError).message).equal('invalid request');
    should((structured as FyHttpError).status).equal(400);
    should((structured as FyHttpError).code).equal('invalid_input');
    should((statusText as FyHttpError).message).equal('Bad Gateway');
    should((generic as FyHttpError).message).equal('fyd returned HTTP 500');
    should(transport.calls).have.length(3);
  });

  it('should make unknown-route errors actionable with route and both protocol versions', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      jsonResponse(
        { error: 'unknown', code: 'unknown_route', method: 'POST', path: '/v1/new' },
        { status: 404, headers: { 'x-fy-version': '1.0.0' } },
      ),
      jsonResponse(
        { error: 'unknown', code: 'unknown_route' },
        { status: 404, headers: { 'x-fy-protocol-version': '9.9.9' } },
      ),
    );
    const client = await connect(transport, { version: '2.0.0' });

    // Act
    const overridden = await captureError(() => client.request('/caller-path', z.string(), { method: 'PATCH' }));
    const fallback = await captureError(() => client.request('/fallback-path', z.string()));

    // Assert
    should(overridden instanceof FyHttpError).be.true();
    should((overridden as FyHttpError).message).containEql('POST /v1/new');
    should((overridden as FyHttpError).message).containEql('fy 2.0.0');
    should((overridden as FyHttpError).message).containEql('fyd 1.0.0');
    should((overridden as FyHttpError).code).equal('unknown_route');
    should((fallback as FyHttpError).message).containEql('GET /fallback-path');
    should((fallback as FyHttpError).message).containEql('fy 2.0.0');
    should((fallback as FyHttpError).message).containEql('fyd unknown');
    should((fallback as FyHttpError).message).not.containEql('9.9.9');
  });
});

describe('FyApiClient protocol version handling', () => {
  it('should report x-fy-version skew at most once and ignore the legacy alias', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      jsonResponse('match', { headers: { 'x-fy-version': '1.2.3' } }),
      jsonResponse('missing'),
      jsonResponse('legacy', { headers: { 'x-fy-protocol-version': '8.0.0' } }),
      jsonResponse('skew', { headers: { 'x-fy-version': '2.0.0' } }),
      jsonResponse('later skew', { headers: { 'x-fy-version': '3.0.0' } }),
    );
    const skews: unknown[] = [];
    const client = await connect(transport, { onVersionSkew: skew => skews.push(skew) });

    // Act
    for (const path of ['/match', '/missing', '/legacy', '/skew', '/later-skew']) {
      await client.request(path, z.string());
    }

    // Assert
    should(skews).have.length(1);
    should(skews[0]).deepEqual({
      clientVersion: '1.2.3',
      daemonVersion: '2.0.0',
      direction: 'daemon-newer',
      message: 'fy 1.2.3 / fyd 2.0.0 — the client is older; update fy',
    });
  });

  it('should tolerate version skew when no callback is installed', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse('ok', { headers: { 'x-fy-version': 'custom' } }));
    const client = await connect(transport);

    // Act
    const actual = await client.request('/no-callback', z.string());

    // Assert
    should(actual).equal('ok');
  });

  it('should delegate the default HTTP transport to a replaced fetch global', async () => {
    // Arrange
    const originalFetch = globalThis.fetch;
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    try {
      const transport = new FetchHttpTransport();

      // Act
      const direct = await transport.send('http://fake.test/direct', { method: 'PATCH' });
      const client = await FyApiClient.connect({ ...BASE_OPTIONS, requestId: () => 'fetch-id' });
      const throughClient = await client.request('/default-fetch', z.object({ ok: z.boolean() }));

      // Assert
      should(await direct.json()).deepEqual({ ok: true });
      should(throughClient).deepEqual({ ok: true });
      should(calls).have.length(2);
      should(String(calls[0]?.input)).equal('http://fake.test/direct');
      should(calls[0]?.init?.method).equal('PATCH');
      should(String(calls[1]?.input)).equal('http://daemon.test/api/default-fetch');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should retain the documented default request timeout constant', () => {
    // Arrange
    const expected = 120_000;

    // Act
    const actual = FY_REQUEST_TIMEOUT_MS;

    // Assert
    should(actual).equal(expected);
  });
});
