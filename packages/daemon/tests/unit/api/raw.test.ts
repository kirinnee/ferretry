import { describe, it } from 'bun:test';
import should from 'should';
import { ApiError } from '../../../src/lib/api/error.ts';
import { ApiRawDispatcher, type RawRoute } from '../../../src/lib/api/raw.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { jsonBody, request } from './support.ts';

/**
 * The byte-shaped route table.
 *
 * Its whole reason to exist is that a subsystem may own the transport's request and response — so
 * these cases are about the boundary AROUND that: who reaches a raw route, what a path this table
 * does not own does, and that a refusal is still rendered in the daemon's own error envelope.
 */

const CREDENTIALS = { admin: 'admin-secret', warden: 'warden-secret' } as const;

const human = { authorization: `Bearer ${CREDENTIALS.admin}` } as const;
const warden = { authorization: `Bearer ${CREDENTIALS.warden}` } as const;

/** Echoes back what the route was handed, so a case can prove the transport request arrived intact
 *  and the authorized context travelled with it. */
function echoRoute(overrides: Partial<RawRoute> = {}): RawRoute {
  return {
    method: 'POST',
    path: '/v1/bytes/:id',
    scope: 'admin',
    serve: async (context, transport) =>
      Response.json({
        id: context.params.get('id'),
        actor: context.actor,
        body: await transport.text(),
        contentType: transport.headers.get('content-type'),
      }),
    ...overrides,
  };
}

function dispatcherFor(...routes: readonly RawRoute[]): ApiRawDispatcher {
  return new ApiRawDispatcher(new ApiRouter(routes), CREDENTIALS);
}

/** The transport request the adapter would hand over, built in memory. */
function transport(path = '/v1/bytes/abc', init: RequestInit = { method: 'POST' }): Request {
  return new Request(`http://127.0.0.1:9999${path}`, init);
}

describe('the raw route table', () => {
  it('should hand an authorized route the transport request itself, not a text copy', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echoRoute());

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'POST', path: '/v1/bytes/abc', headers: human }),
      transport('/v1/bytes/abc', {
        method: 'POST',
        body: 'raw-bytes',
        headers: { 'content-type': 'audio/wav' },
      }),
    );

    // Assert
    should(decision.kind).equal('served');
    if (decision.kind !== 'served') return;
    should(decision.response.status).equal(200);
    should(await decision.response.json()).deepEqual({
      id: 'abc',
      actor: 'admin-ui',
      body: 'raw-bytes',
      contentType: 'audio/wav',
    });
  });

  it('should leave a path no raw route claims to the request/response table', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echoRoute());

    // Act / Assert
    should(dispatcher.claims(request({ method: 'GET', path: '/v1/health' }))).equal(false);
    should(dispatcher.claims(request({ method: 'POST', path: '/v1/bytes/abc' }))).equal(true);
  });

  it('should answer unclaimed for a path the router does not hold', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echoRoute());

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'GET', path: '/v1/health', headers: human }),
      transport('/v1/health', { method: 'GET' }),
    );

    // Assert
    should(decision.kind).equal('unclaimed');
  });

  it('should refuse an unauthenticated caller before the subsystem is reached', async () => {
    // Arrange
    let reached = false;
    const dispatcher = dispatcherFor(
      echoRoute({
        serve: async () => {
          reached = true;
          return Response.json({});
        },
      }),
    );

    // Act
    const decision = await dispatcher.serve(request({ method: 'POST', path: '/v1/bytes/abc' }), transport());

    // Assert
    should(decision.kind).equal('refused');
    if (decision.kind !== 'refused') return;
    should(decision.response.status).equal(401);
    should(reached).equal(false);
  });

  it('should refuse the warden token on an admin raw route', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echoRoute());

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'POST', path: '/v1/bytes/abc', headers: warden }),
      transport(),
    );

    // Assert
    should(decision.kind).equal('refused');
    if (decision.kind !== 'refused') return;
    should(decision.response.status).equal(403);
    should(jsonBody(decision.response).code).equal('forbidden');
  });

  it('should answer 405 with an Allow header for a verb the path does not take', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echoRoute());

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'DELETE', path: '/v1/bytes/abc', headers: human }),
      transport('/v1/bytes/abc', { method: 'DELETE' }),
    );

    // Assert
    should(decision.kind).equal('refused');
    if (decision.kind !== 'refused') return;
    should(decision.response.status).equal(405);
    should(decision.response.headers.get('allow')).equal('POST');
  });

  it("should keep a subsystem's own refusal status when it throws ApiError", async () => {
    // Arrange
    const dispatcher = dispatcherFor(
      echoRoute({
        serve: async () => {
          throw new ApiError(409, 'a transcription is already running', 'busy');
        },
      }),
    );

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'POST', path: '/v1/bytes/abc', headers: human }),
      transport(),
    );

    // Assert
    should(decision.kind).equal('refused');
    if (decision.kind !== 'refused') return;
    should(decision.response.status).equal(409);
    should(jsonBody(decision.response).code).equal('busy');
  });

  it('should report an unexpected failure as the daemon’s fault rather than the caller’s', async () => {
    // Arrange
    const dispatcher = dispatcherFor(
      echoRoute({
        serve: async () => {
          throw new Error('the model file is unreadable');
        },
      }),
    );

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'POST', path: '/v1/bytes/abc', headers: human }),
      transport(),
    );

    // Assert
    should(decision.kind).equal('refused');
    if (decision.kind !== 'refused') return;
    should(decision.response.status).equal(500);
    should(jsonBody(decision.response).code).equal('internal_error');
    // The prose the subsystem threw must not travel to the caller: it names a host path.
    should(decision.response.body).not.match(/unreadable/u);
  });

  it('should serve a public raw route without any token at all', async () => {
    // Arrange
    const dispatcher = dispatcherFor(
      echoRoute({ method: 'GET', path: '/public/bytes', scope: 'public', serve: async () => new Response('ok') }),
    );

    // Act
    const decision = await dispatcher.serve(
      request({ method: 'GET', path: '/public/bytes' }),
      transport('/public/bytes', { method: 'GET' }),
    );

    // Assert
    should(decision.kind).equal('served');
    if (decision.kind !== 'served') return;
    should(await decision.response.text()).equal('ok');
  });
});
