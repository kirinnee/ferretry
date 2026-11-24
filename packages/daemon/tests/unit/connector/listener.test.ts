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
    should(
      resolveApiActor({ tokenClass: 'admin', sessionId: 's1', client: 'connector:cg_abcdefghij' }),
    ).equal('peer:s1');
  });
});
