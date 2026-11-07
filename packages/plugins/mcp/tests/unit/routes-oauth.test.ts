/**
 * The MCP sign-in at the daemon's front door (docs/mcp-oauth.md): which capability each route needs,
 * which status a refusal becomes, and that the callback address arrives in a body and is answered with
 * nothing that repeats it. The service behind it is the real one over a fake provider.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { mcpOAuthRoutes, type McpOAuthSubsystem } from '../../../../src/lib/runtime/mounts/mcp-oauth.ts';
import { jsonBody, request } from '../../api/support.ts';
import { leaks, PWA_REDIRECT, world } from '../../mcp-oauth/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

function dispatcher(subsystem: McpOAuthSubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(mcpOAuthRoutes(subsystem)), CREDENTIALS, GRANTED);
}

const post = (path: string, body?: unknown) =>
  request({
    method: 'POST',
    path,
    headers: { ...human, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('the MCP sign-in routes', () => {
  it('should read with fleet.use and change with fleet.configure, all uncacheable', () => {
    // Arrange / Act
    const routes = mcpOAuthRoutes(world().service);

    // Assert
    should(routes.map(route => `${route.method} ${route.path} ${route.capability?.axis}`)).deepEqual([
      'GET /v1/fleet/mcp-auth use',
      'POST /v1/fleet/mcp-auth/:component configure',
      'DELETE /v1/fleet/mcp-auth/:component configure',
      'POST /v1/fleet/mcp-auth/flows/:flowId configure',
      'DELETE /v1/fleet/mcp-auth/flows/:flowId configure',
    ]);
    should(routes.every(route => route.noStore === true && route.capability?.capability === 'fleet')).be.true();
    should(routes.every(route => route.minimum === 'operator')).be.true();
  });

  it('should sign in end to end, and no answer should carry a token or a code', async () => {
    // Arrange
    const w = world({ expiresIn: 3600 });
    const api = dispatcher(w.service);

    // Act
    const started = await api.dispatch(post('/v1/fleet/mcp-auth/linear', { redirectUri: PWA_REDIRECT }));
    const flow = jsonBody(started) as { flowId: string; authorizeUrl: string };
    const callback = await w.provider.approve(flow.authorizeUrl);
    const finished = await api.dispatch(post(`/v1/fleet/mcp-auth/flows/${flow.flowId}`, { callback }));
    const listed = await api.dispatch(request({ path: '/v1/fleet/mcp-auth', headers: human }));
    const replayed = await api.dispatch(post(`/v1/fleet/mcp-auth/flows/${flow.flowId}`, { callback }));
    const signedOut = await api.dispatch(
      request({ method: 'DELETE', path: '/v1/fleet/mcp-auth/linear', headers: human }),
    );

    // Assert
    should(started.status).equal(200);
    should(finished.status).equal(200);
    should(jsonBody(finished)).containEql({ component: 'linear' });
    should((jsonBody(listed).connections as { state: string }[])[0]?.state).equal('signed-in');
    should(replayed.status).equal(404);
    should(jsonBody(replayed)).containEql({ code: 'mcp_auth_unknown_flow' });
    should(jsonBody(signedOut)).deepEqual({ component: 'linear', removed: true, revoked: true });
    for (const response of [started, finished, listed, replayed, signedOut]) {
      should(response.headers.get('cache-control')).equal('no-store');
      should(leaks(w.provider, response.body)).deepEqual([]);
    }
  });

  it('should start in paste mode with no body, and cancel a flow', async () => {
    // Arrange
    const w = world();
    const api = dispatcher(w.service);

    // Act
    const started = await api.dispatch(post('/v1/fleet/mcp-auth/linear'));
    const { flowId } = jsonBody(started) as { flowId: string };
    const cancelled = await api.dispatch(
      request({ method: 'DELETE', path: `/v1/fleet/mcp-auth/flows/${flowId}`, headers: human }),
    );

    // Assert
    should(jsonBody(started)).containEql({ mode: 'paste' });
    should(jsonBody(cancelled)).deepEqual({ flowId, cancelled: true });
  });

  it('should answer 404 for an unknown server and 409 for every other refusal', async () => {
    // Arrange
    const api = dispatcher(world().service);

    // Act
    const unknown = await api.dispatch(post('/v1/fleet/mcp-auth/nope'));
    const plain = await api.dispatch(post('/v1/fleet/mcp-auth/plain'));

    // Assert
    should(unknown.status).equal(404);
    should(plain.status).equal(409);
    should(jsonBody(plain)).containEql({ code: 'mcp_auth_not_oauth' });
  });

  it('should refuse an unusable path parameter and pass any other failure through', async () => {
    // Arrange
    const failing: McpOAuthSubsystem = {
      ...world().service,
      connections: async () => {
        throw new Error('the state document is damaged');
      },
      start: async () => {
        throw new Error('unreachable');
      },
      complete: async () => {
        throw new Error('unreachable');
      },
      cancel: () => {
        throw new Error('unreachable');
      },
      signOut: async () => {
        throw new Error('unreachable');
      },
    };
    const api = dispatcher(failing);

    // Act
    const bad = await api.dispatch(post('/v1/fleet/mcp-auth/%E0%A4%A'));
    const damaged = await api.dispatch(request({ path: '/v1/fleet/mcp-auth', headers: human }));

    // Assert
    should(bad.status).equal(400);
    should(damaged.status).equal(500);
  });
});
