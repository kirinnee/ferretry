import { describe, it } from 'bun:test';
import should from 'should';
import { isHumanAdminActor, resolveApiActor } from '../../../src/lib/api/actor.ts';
import { type ApiRequest, type ApiResponse, headersFrom, queryFrom } from '../../../src/lib/api/http.ts';
import { connectorListenerSurface, InProcessConnectorDispatch } from '../../../src/lib/connector/listener.ts';

const request = (path: string, method = 'GET'): ApiRequest => ({
  method,
  path,
  query: queryFrom([]),
  headers: headersFrom({}),
  loopback: true,
  privilegedLoopback: true,
  text: async () => '',
});
const ok = (body: string): ApiResponse => ({ status: 200, headers: new Map(), body });

describe('connectorListenerSurface', () => {
  it('offers each request to the handlers in order and 404s what none claims', async () => {
    const surface = connectorListenerSurface([
      { handle: async r => (r.path === '/a' ? ok('a') : undefined) },
      { handle: async r => (r.path === '/b' ? ok('b') : undefined) },
    ]);
    should((await surface.http.dispatch(request('/b'))).body).equal('b');
    const missing = await surface.http.dispatch(request('/v1/sessions'));
    should(missing.status).equal(404);
    // The same answer for any method, so the surface cannot be mapped.
    should((await surface.http.dispatch(request('/v1/sessions', 'POST'))).body).equal(missing.body);
  });

  it('never switches a socket and admits no browser origin', async () => {
    const surface = connectorListenerSurface([]);
    should(surface.sockets.claims(request('/v1/rendezvous/x/client'))).be.false();
    should(await surface.sockets.upgrade(request('/v1/rendezvous/x/client'))).deepEqual({ outcome: 'unclaimed' });
    should(surface.corsOrigins).deepEqual([]);
  });
});

describe('InProcessConnectorDispatch', () => {
  it('sends the owner request attributed to the grant', async () => {
    let seen: ApiRequest | undefined;
    let seenBody = '';
    const dispatch = new InProcessConnectorDispatch({
      dispatch: async r => {
        seen = r;
        seenBody = await r.text(1024);
        return ok('{"ok":true}');
      },
      adminToken: () => 'admin-token-value',
    });
    const answer = await dispatch.call('cg_abcdefghij', {
      method: 'POST',
      path: '/v1/sessions/s1/send',
      body: { text: 'hi' },
    });
    should(answer).deepEqual({ status: 200, body: '{"ok":true}' });
    should(seen?.headers.get('authorization')).equal('Bearer admin-token-value');
    should(seen?.headers.get('x-ferretry-client')).equal('connector:cg_abcdefghij');
    should(seenBody).equal('{"text":"hi"}');
  });

  it('refuses a path outside /v1/ or carrying a query', async () => {
    const dispatch = new InProcessConnectorDispatch({ dispatch: async () => ok(''), adminToken: () => 't' });
    await should(dispatch.call('cg_abcdefghij', { method: 'GET', path: '/attach' })).be.rejected();
    await should(dispatch.call('cg_abcdefghij', { method: 'GET', path: '/v1/x?y=1' })).be.rejected();
  });
});

describe('the connector actor', () => {
  it('is the grant for the admin token with a connector client, and counts as the owner', () => {
    const actor = resolveApiActor({ tokenClass: 'admin', client: 'connector:cg_abcdefghij' });
    should(actor).equal('connector:cg_abcdefghij');
    should(isHumanAdminActor(actor)).be.true();
  });

  it('is never claimed by another credential or a malformed client', () => {
    should(resolveApiActor({ tokenClass: 'admin', client: 'connector:../x' })).equal('admin-ui');
    should(resolveApiActor({ tokenClass: 'device', deviceId: 'd1', client: 'connector:cg_abcdefghij' })).equal(
      'device:d1',
    );
    should(resolveApiActor({ tokenClass: 'session', sessionId: 's1', client: 'connector:cg_abcdefghij' })).equal(
      'peer:s1',
    );
    // A session header still names the ferret: the connector client cannot hide an agent.
    should(resolveApiActor({ tokenClass: 'admin', sessionId: 's1', client: 'connector:cg_abcdefghij' })).equal(
      'peer:s1',
    );
  });
});

describe('InProcessConnectorDispatch body bound', () => {
  it('refuses a body over the route limit the way the transport does', async () => {
    let refusal: unknown;
    const dispatch = new InProcessConnectorDispatch({
      dispatch: async r => {
        refusal = await r.text(4).catch((error: unknown) => error);
        return ok('');
      },
      adminToken: () => 't',
    });
    await dispatch.call('cg_abcdefghij', { method: 'POST', path: '/v1/x', body: { text: 'long enough' } });
    should((refusal as Error).name).equal('BodyTooLargeError');
  });

  it('refuses a body over the in-process limit before dispatching', async () => {
    const dispatch = new InProcessConnectorDispatch({ dispatch: async () => ok(''), adminToken: () => 't' });
    await should(
      dispatch.call('cg_abcdefghij', { method: 'POST', path: '/v1/x', body: { text: 'x'.repeat(70_000) } }),
    ).be.rejected();
  });
});

describe('InProcessConnectorDispatch headers', () => {
  it('forwards only the request id a tool may set, and only when it is well formed', async () => {
    const seen: ApiRequest[] = [];
    const dispatch = new InProcessConnectorDispatch({
      dispatch: async r => {
        seen.push(r);
        return ok('{}');
      },
      adminToken: () => 'admin-token-value',
    });
    await dispatch.call('cg_abcdefghij', {
      method: 'POST',
      path: '/v1/x',
      headers: { 'X-Fy-Request-Id': 'req-1', authorization: 'Bearer stolen', 'x-forwarded-for': '1.2.3.4' },
    });
    await dispatch.call('cg_abcdefghij', { method: 'POST', path: '/v1/x', headers: { 'x-fy-request-id': 'bad id\n' } });
    should(seen[0]?.headers.get('x-fy-request-id')).equal('req-1');
    // A header a tool names cannot replace the grant's own credentials or add a forwarding claim.
    should(seen[0]?.headers.get('authorization')).equal('Bearer admin-token-value');
    should(seen[0]?.headers.get('x-forwarded-for')).be.undefined();
    should(seen[1]?.headers.get('x-fy-request-id')).be.undefined();
  });
});

describe('InProcessConnectorDispatch arrival', () => {
  it('arrives remote and unprivileged, so the boundary governs it', async () => {
    let seen: ApiRequest | undefined;
    const dispatch = new InProcessConnectorDispatch({
      dispatch: async r => {
        seen = r;
        return ok('');
      },
      adminToken: () => 't',
    });
    await dispatch.call('cg_abcdefghij', {
      method: 'POST',
      path: '/v1/x',
      headers: { 'X-Fy-Request-Id': 'connector-1', authorization: 'Bearer forged', 'x-ferretry-session-id': 's1' },
    });
    should(seen?.loopback).be.false();
    should(seen?.privilegedLoopback).be.false();
    should(seen?.headers.get('x-fy-request-id')).equal('connector-1');
    should(seen?.headers.get('authorization')).equal('Bearer t');
    should(seen?.headers.has('x-ferretry-session-id')).be.false();
  });
});
