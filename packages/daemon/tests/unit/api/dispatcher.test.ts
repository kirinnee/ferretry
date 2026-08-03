import { describe, it } from 'bun:test';
import should from 'should';
import {
  ApiDispatcher,
  ApiError,
  type ApiRoute,
  ApiRouter,
  CLIENT_HEADER,
  jsonResponse,
  type RouteScope,
  SESSION_ID_HEADER,
} from '../../../src/lib/api/index.ts';
import { jsonBody, request } from './support.ts';

const credentials = {
  admin: 'admin-secret',
  warden: 'warden-secret',
  devices: { identify: (token: string) => (token === 'device-secret' ? 'device-1' : undefined) },
};

/** Echoes back what the dispatcher decided, so a test asserts the decision rather than a mock call. */
const echo = (path: string, scope: RouteScope, method = 'GET'): ApiRoute => ({
  method,
  path,
  scope,
  handle: async context => jsonResponse({ actor: context.actor ?? null, params: [...context.params] }),
});

const dispatcherFor = (...routes: readonly ApiRoute[]) => new ApiDispatcher(new ApiRouter(routes), credentials);

describe('ApiDispatcher authorization', () => {
  it('should serve a public route with no token at all', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/healthz', 'public'));

    // Act
    const response = await dispatcher.dispatch(request({ path: '/healthz' }));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).actor).be.null();
  });

  it('should refuse an unauthenticated request to a token route', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'));

    // Act
    const response = await dispatcher.dispatch(request({ path: '/v1/sessions' }));

    // Assert
    should(response.status).equal(401);
    should(jsonBody(response).code).equal('unauthorized');
  });

  it('should hide whether an unknown path exists from an unauthenticated caller', async () => {
    // 404 versus 405 is a map of the private surface; both must be 401 until a token proves the
    // caller is entitled to know.
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'));

    // Act
    const unknown = await dispatcher.dispatch(request({ path: '/v1/secret-thing' }));
    const wrongVerb = await dispatcher.dispatch(request({ method: 'DELETE', path: '/v1/sessions' }));

    // Assert
    should(unknown.status).equal(401);
    should(wrongVerb.status).equal(401);
  });

  it('should answer unknown_route once the caller is authenticated', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'));

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/future', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response).code).equal('unknown_route');
  });

  it('should answer 405 for a known path under the wrong verb', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'));

    // Act
    const response = await dispatcher.dispatch(
      request({ method: 'DELETE', path: '/v1/sessions', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(response.status).equal(405);
    should(response.headers.get('allow')).equal('GET');
  });

  it('should refuse an admin-scoped route to the warden token', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'));

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/sessions', headers: { authorization: 'Bearer warden-secret' } }),
    );

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('forbidden');
  });

  it('should allow a warden-scoped route to both tokens', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/usage', 'warden'));

    // Act
    const asWarden = await dispatcher.dispatch(
      request({ path: '/v1/usage', headers: { authorization: 'Bearer warden-secret' } }),
    );
    const asAdmin = await dispatcher.dispatch(
      request({ path: '/v1/usage', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(asWarden.status).equal(200);
    should(asAdmin.status).equal(200);
  });

  it('should let a paired device use operator routes but never host-only routes', async () => {
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'), echo('/v1/pair/code', 'host', 'POST'));

    const operator = await dispatcher.dispatch(
      request({ path: '/v1/sessions', headers: { authorization: 'Bearer device-secret' } }),
    );
    const hostOnly = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/pair/code',
        headers: { authorization: 'Bearer device-secret' },
      }),
    );
    const hostAdmin = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/pair/code', headers: { authorization: 'Bearer admin-secret' } }),
    );

    should(operator.status).equal(200);
    should(jsonBody(operator).actor).equal('device:device-1');
    should(hostOnly.status).equal(403);
    should(jsonBody(hostOnly).error).equal('the presented credential may not use POST /v1/pair/code');
    should(hostAdmin.status).equal(200);
  });

  it('should honour a query token only for a loopback peer', async () => {
    // A token in a URL is logged by every proxy on the path.
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/events', 'admin'));

    // Act
    const local = await dispatcher.dispatch(
      request({ path: '/v1/events', query: [['token', 'admin-secret']], loopback: true }),
    );
    const remote = await dispatcher.dispatch(
      request({ path: '/v1/events', query: [['token', 'admin-secret']], loopback: false }),
    );

    // Assert
    should(local.status).equal(200);
    should(remote.status).equal(401);
  });
});

describe('ApiDispatcher attribution', () => {
  it('should attribute the admin token with no headers to the UI', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'));

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/sessions', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(jsonBody(response).actor).equal('admin-ui');
  });

  it('should attribute a self-identified CLI caller to admin-cli', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'));

    // Act
    const response = await dispatcher.dispatch(
      request({
        path: '/v1/sessions',
        headers: { authorization: 'Bearer admin-secret', [CLIENT_HEADER]: 'cli' },
      }),
    );

    // Assert
    should(jsonBody(response).actor).equal('admin-cli');
  });

  it('should attribute an in-pane admin caller to its own session', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'));

    // Act
    const response = await dispatcher.dispatch(
      request({
        path: '/v1/sessions',
        headers: { authorization: 'Bearer admin-secret', [SESSION_ID_HEADER]: 's-7' },
      }),
    );

    // Assert
    should(jsonBody(response).actor).equal('peer:s-7');
  });

  it('should attribute the warden token to the warden', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/usage', 'warden'));

    // Act
    const response = await dispatcher.dispatch(
      request({
        path: '/v1/usage',
        headers: { authorization: 'Bearer warden-secret', [SESSION_ID_HEADER]: 'w-1' },
      }),
    );

    // Assert
    should(jsonBody(response).actor).equal('warden:w-1');
  });

  it('should ignore spoofed actor headers on a device credential', async () => {
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'));

    const response = await dispatcher.dispatch(
      request({
        path: '/v1/sessions',
        headers: {
          authorization: 'Bearer device-secret',
          [SESSION_ID_HEADER]: 'spoofed-peer',
          [CLIENT_HEADER]: 'cli',
        },
      }),
    );

    should(jsonBody(response).actor).equal('device:device-1');
  });

  it('should not let a stop-capability header relabel an admin caller as the warden', async () => {
    // The source flipped the token class whenever this header was merely present, so an admin CLI
    // passing one had its own actions journalled as the warden's.
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'admin'));

    // Act
    const response = await dispatcher.dispatch(
      request({
        path: '/v1/sessions',
        headers: {
          authorization: 'Bearer admin-secret',
          [CLIENT_HEADER]: 'cli',
          'x-ferretry-stop-capability': 'anything',
        },
      }),
    );

    // Assert
    should(jsonBody(response).actor).equal('admin-cli');
  });

  it('should pass captured path parameters to the handler', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions/:id', 'admin'));

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/sessions/s-9', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(jsonBody(response).params).deepEqual([['id', 's-9']]);
  });
});

describe('ApiDispatcher error handling', () => {
  const failing = (error: unknown, scope: RouteScope = 'public'): ApiRoute => ({
    method: 'GET',
    path: '/boom',
    scope,
    handle: async () => {
      throw error;
    },
  });

  it('should answer an ApiError with its own status and code', async () => {
    // Arrange
    const dispatcher = dispatcherFor(failing(new ApiError(409, 'already running', 'conflict')));

    // Act
    const response = await dispatcher.dispatch(request({ path: '/boom' }));

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).deepEqual({ error: 'already running', code: 'conflict' });
  });

  it('should never leak an unexpected error message to the client', async () => {
    // Arrange
    const dispatcher = dispatcherFor(failing(new Error('/home/someone/.ferretry/state.db is locked')));

    // Act
    const response = await dispatcher.dispatch(request({ path: '/boom' }));

    // Assert
    should(response.status).equal(500);
    should(response.body).not.containEql('.ferretry');
    should(jsonBody(response).code).equal('internal_error');
  });

  it('should handle a thrown non-Error just as safely', async () => {
    // Arrange
    const dispatcher = dispatcherFor(failing('a bare string'));

    // Act
    const response = await dispatcher.dispatch(request({ path: '/boom' }));

    // Assert
    should(response.status).equal(500);
  });

  it('should still mark a failed no-store route uncacheable', async () => {
    // Arrange
    const route: ApiRoute = { ...failing(new ApiError(404, 'gone')), noStore: true };
    const dispatcher = dispatcherFor(route);

    // Act
    const response = await dispatcher.dispatch(request({ path: '/boom' }));

    // Assert
    should(response.headers.get('cache-control')).equal('no-store');
  });

  it('should mark an authenticated no-store route uncacheable', async () => {
    // Arrange
    const dispatcher = dispatcherFor({ ...echo('/v1/usage', 'warden'), noStore: true });

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/usage', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(response.headers.get('cache-control')).equal('no-store');
  });
});
