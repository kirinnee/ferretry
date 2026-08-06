import { describe, it } from 'bun:test';
import should from 'should';
import {
  ApiDispatcher,
  ApiError,
  type ApiRoute,
  ApiRouter,
  authorizeRequest,
  type CapabilityGuard,
  CLIENT_HEADER,
  type CredentialMinimum,
  jsonResponse,
  NO_GOVERNED_ROUTES_GUARD,
  SESSION_ID_HEADER,
  WARDEN_CAPABILITY_HEADER,
  type WardenRemedyAuthorizer,
  type WardenRemedyDecision,
  type WardenRemedyPresentation,
} from '../../../src/lib/api/index.ts';
import { jsonBody, request } from './support.ts';

const credentials = {
  admin: 'admin-secret',
  warden: 'warden-secret',
  devices: { identify: (token: string) => (token === 'device-secret' ? 'device-1' : undefined) },
};

/** Echoes back what the dispatcher decided, so a test asserts the decision rather than a mock call. */
const echo = (path: string, minimum: CredentialMinimum, method = 'GET', privilegedOnly?: true): ApiRoute => ({
  method,
  path,
  minimum,
  ...(privilegedOnly === true ? { privilegedOnly: true } : {}),
  handle: async context => jsonResponse({ actor: context.actor ?? null, params: [...context.params] }),
});

const dispatcherFor = (...routes: readonly ApiRoute[]) =>
  new ApiDispatcher(new ApiRouter(routes), credentials, NO_GOVERNED_ROUTES_GUARD);

describe('ApiDispatcher authorization', () => {
  it('should serve a public route with no token at all', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/healthz', 'none'));

    // Act
    const response = await dispatcher.dispatch(request({ path: '/healthz' }));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).actor).be.null();
  });

  it('should refuse an unauthenticated request to a token route', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));

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
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));

    // Act
    const unknown = await dispatcher.dispatch(request({ path: '/v1/secret-thing' }));
    const wrongVerb = await dispatcher.dispatch(request({ method: 'DELETE', path: '/v1/sessions' }));

    // Assert
    should(unknown.status).equal(401);
    should(wrongVerb.status).equal(401);
  });

  it('should answer unknown_route once the caller is authenticated', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));

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
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));

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
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));

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
    const dispatcher = dispatcherFor(echo('/v1/usage', 'authenticated'));

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

  it('should let a paired device use operator routes but never an admin-token route', async () => {
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'), echo('/v1/pair/code', 'admin-token', 'POST'));

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

  it('should decide credential minimum and privileged arrival independently', async () => {
    const dispatcher = dispatcherFor(echo('/v1/local', 'operator', 'POST', true));
    const localAdmin = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/local', headers: { authorization: 'Bearer admin-secret' }, loopback: true }),
    );
    const localDevice = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/local',
        headers: { authorization: 'Bearer device-secret' },
        loopback: true,
      }),
    );
    const remoteAdmin = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/local',
        headers: { authorization: 'Bearer admin-secret' },
        loopback: false,
      }),
    );
    const remoteDevice = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/local',
        headers: { authorization: 'Bearer device-secret' },
        loopback: false,
      }),
    );

    should(localAdmin.status).equal(200);
    should(localDevice.status).equal(200);
    should(remoteAdmin.status).equal(403);
    should(remoteDevice.status).equal(403);
  });

  it('should honour a query token only for a loopback peer', async () => {
    // A token in a URL is logged by every proxy on the path.
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/events', 'operator'));

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
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/sessions', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(jsonBody(response).actor).equal('admin-ui');
  });

  it('should attribute a self-identified CLI caller to admin-cli', async () => {
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));

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
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));

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
    const dispatcher = dispatcherFor(echo('/v1/usage', 'authenticated'));

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
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));

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
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));

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
    const dispatcher = dispatcherFor(echo('/v1/sessions/:id', 'operator'));

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/sessions/s-9', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(jsonBody(response).params).deepEqual([['id', 's-9']]);
  });
});

describe('ApiDispatcher error handling', () => {
  const failing = (error: unknown, minimum: CredentialMinimum = 'none'): ApiRoute => ({
    method: 'GET',
    path: '/boom',
    minimum,
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
    const dispatcher = dispatcherFor({ ...echo('/v1/usage', 'authenticated'), noStore: true });

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/usage', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(response.headers.get('cache-control')).equal('no-store');
  });
});

describe('the operator grant layer', () => {
  /** A route that names a capability, so the guard is consulted for it. */
  const governed = (): ApiRoute => ({
    method: 'GET',
    path: '/v1/fleet/plan',
    minimum: 'operator',
    capability: { capability: 'fleet', axis: 'use' },
    handle: async () => jsonResponse({ plan: [] }),
  });

  const guard = (allowed: boolean): CapabilityGuard => ({
    decide: () => ({ allowed, refusal: allowed ? 'granted' : 'not-granted' }),
    explain: () => 'the operator of this machine has not granted the UI the use of the agent fleet',
  });

  it('should ask the guard only AFTER authentication and the route scope have both passed', async () => {
    // The order is the invariant. By the time a grant is consulted the request is one this daemon
    // WOULD have served, so the only thing the grant can do is decline it — which is what makes "a
    // grant only ever narrows" a property of the code rather than a promise in a document.
    // Arrange — a guard that would allow anything, in front of a route the caller cannot reach.
    const asked: string[] = [];
    const recording: CapabilityGuard = {
      decide: demand => {
        asked.push(demand.capability);
        return { allowed: true, refusal: 'granted' };
      },
      explain: () => undefined,
    };
    const dispatcher = new ApiDispatcher(new ApiRouter([governed()]), credentials, recording);

    // Act — anonymous, so authentication refuses before anything else runs.
    const anonymous = await dispatcher.dispatch(request({ path: '/v1/fleet/plan' }));

    // Assert — the guard was never consulted, and a permissive one cannot rescue the request.
    should(anonymous.status).equal(401);
    should(asked).be.empty();
  });

  it('should refuse a governed route with the guard’s own sentence and a reason code', async () => {
    // A denial that says only "forbidden" is the dead end this exists to remove: the reason code lets
    // a client tell "the operator said no" from "you need to unlock" without parsing prose.
    // Arrange
    const dispatcher = new ApiDispatcher(new ApiRouter([governed()]), credentials, guard(false));

    // Act
    const answered = await dispatcher.dispatch(
      request({ path: '/v1/fleet/plan', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(answered.status).equal(403);
    should(JSON.parse(answered.body)).containDeep({ code: 'grant_not_granted' });
    should(answered.body).match(/has not granted the UI the use of the agent fleet/u);
  });

  it('should leave an ungoverned route untouched by the grant layer', async () => {
    // Most of the daemon's surface lives inside its own state home and is not one of the five things
    // an operator is asked about. A grant list that grew to cover every route would be a second copy
    // of the route table.
    // Arrange
    const ungoverned: ApiRoute = {
      method: 'GET',
      path: '/v1/sessions',
      minimum: 'operator',
      handle: async () => jsonResponse([]),
    };
    const dispatcher = new ApiDispatcher(new ApiRouter([ungoverned]), credentials, guard(false));

    // Act
    const answered = await dispatcher.dispatch(
      request({ path: '/v1/sessions', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(answered.status).equal(200);
  });

  it('should hand the guard the transport’s loopback answer and the unlock header', async () => {
    // NEITHER IS SELF-REPORTED IN A WAY THAT MATTERS: `loopback` is the transport's own account of
    // where the socket came from — a relayed hop is never loopback — and the unlock is a value this
    // daemon minted itself.
    // Arrange
    const seen: { loopback?: boolean; unlock?: string }[] = [];
    const recording: CapabilityGuard = {
      decide: (_demand, presentation) => {
        seen.push({ loopback: presentation.loopback, unlock: presentation.unlock });
        return { allowed: true, refusal: 'granted' };
      },
      explain: () => undefined,
    };
    const dispatcher = new ApiDispatcher(new ApiRouter([governed()]), credentials, recording);

    // Act
    await dispatcher.dispatch(
      request({
        path: '/v1/fleet/plan',
        headers: { authorization: 'Bearer admin-secret', 'x-ferretry-operator-unlock': 'fy_unlock_abc' },
        loopback: true,
      }),
    );

    // Assert
    should(seen).deepEqual([{ loopback: true, unlock: 'fy_unlock_abc' }]);
  });
});

describe('the warden remedy axis', () => {
  /** A route the administrator may allow a warden to act on. The remedy name is opaque here: the
   *  closed set belongs to the protocol, and a second list written beside the route would be that one
   *  fact acquiring a second owner. */
  const remedial = (minimum: CredentialMinimum = 'authenticated'): ApiRoute => ({
    method: 'POST',
    path: '/v1/sessions/:id/stop',
    minimum,
    wardenRemedy: 'kill',
    handle: async context => jsonResponse({ actor: context.actor ?? null, params: [...context.params] }),
  });

  /** Records every presentation it is shown, so a case can assert the authorizer was NOT consulted. */
  const authorizer = (
    decision: WardenRemedyDecision | undefined,
    seen: WardenRemedyPresentation[] = [],
  ): WardenRemedyAuthorizer => ({
    decide: presentation => {
      seen.push(presentation);
      return decision;
    },
  });

  const allowing = (seen?: WardenRemedyPresentation[]) => authorizer({ allowed: true }, seen);

  const wardenRequest = (headers: Readonly<Record<string, string>> = {}) =>
    request({
      method: 'POST',
      path: '/v1/sessions/s-3/stop',
      headers: { authorization: 'Bearer warden-secret', [SESSION_ID_HEADER]: 'w-1', ...headers },
    });

  it('should serve a declared remedy to a warden the authorizer allows, as the warden', async () => {
    // Arrange
    const seen: WardenRemedyPresentation[] = [];
    const dispatcher = new ApiDispatcher(
      new ApiRouter([remedial()]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      allowing(seen),
    );

    // Act
    const response = await dispatcher.dispatch(wardenRequest({ [WARDEN_CAPABILITY_HEADER]: '  cap-7  ' }));

    // Assert — and everything the policy is handed is server-derived except the capability itself,
    // which is a secret this daemon minted rather than a claim the caller made about itself.
    should(response.status).equal(200);
    should(jsonBody(response).actor).equal('warden:w-1');
    should(seen).have.length(1);
    should(seen[0]?.remedy).equal('kill');
    should(seen[0]?.capability).equal('cap-7');
    should(seen[0]?.actor).equal('warden:w-1');
    should([...(seen[0]?.params ?? [])]).deepEqual([['id', 's-3']]);
    should(seen[0]?.request.path).equal('/v1/sessions/s-3/stop');
  });

  it('should refuse a warden on a route whose declared remedy is blank, and trim one that is not', async () => {
    // `WardenRemedyName` is `string`, so nothing in the type stopped `''` being written. A nameless
    // question cannot be put to an authorizer and cannot be named in a refusal, so the boundary stops
    // at it rather than carrying the gap forward — capability presented or not.
    // Arrange
    const seen: WardenRemedyPresentation[] = [];
    const blankRemedy = new ApiDispatcher(
      new ApiRouter([{ ...remedial(), wardenRemedy: '   ' }]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      allowing(seen),
    );
    const paddedRemedy = new ApiDispatcher(
      new ApiRouter([{ ...remedial(), wardenRemedy: '  kill  ' }]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      allowing(seen),
    );

    // Act
    const carrying = await blankRemedy.dispatch(wardenRequest({ [WARDEN_CAPABILITY_HEADER]: 'cap-7' }));
    const bare = await blankRemedy.dispatch(wardenRequest());
    const padded = await paddedRemedy.dispatch(wardenRequest({ [WARDEN_CAPABILITY_HEADER]: 'cap-7' }));

    // Assert — the blank declaration is refused both ways and reaches no authorizer; the padded one
    // is the same remedy as any other and arrives trimmed.
    should(carrying.status).equal(403);
    should(jsonBody(carrying).code).equal('warden_remedy_undetermined');
    should(carrying.body).match(/declares a blank warden remedy/u);
    should(bare.status).equal(403);
    should(jsonBody(bare).code).equal('warden_remedy_undetermined');
    should(padded.status).equal(200);
    should(seen).have.length(1);
    should(seen[0]?.remedy).equal('kill');
  });

  it('should refuse a warden that presents no capability, naming the header that would carry one', async () => {
    // A blank secret is not a weaker answer — it is the absence of one.
    // Arrange
    const dispatcher = new ApiDispatcher(
      new ApiRouter([remedial()]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      allowing(),
    );

    // Act
    const absent = await dispatcher.dispatch(wardenRequest());
    const blank = await dispatcher.dispatch(wardenRequest({ [WARDEN_CAPABILITY_HEADER]: '   ' }));

    // Assert
    should(absent.status).equal(403);
    should(blank.status).equal(403);
    should(jsonBody(absent).code).equal('warden_capability_required');
    should(jsonBody(blank).code).equal('warden_capability_required');
    should(absent.body).match(/x-fy-warden-capability/u);
  });

  it('should refuse a warden when a remedy route is served with no authorizer wired', async () => {
    // A route that declares a remedy and a boundary built without an authorizer is a wiring mistake,
    // and the safe reading of "nobody can tell me whether this is allowed" is that it is not.
    // Arrange
    const dispatcher = new ApiDispatcher(new ApiRouter([remedial()]), credentials, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const response = await dispatcher.dispatch(wardenRequest({ [WARDEN_CAPABILITY_HEADER]: 'cap-7' }));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('warden_remedy_undetermined');
    should(response.body).match(/must be wired with one/u);
  });

  it('should refuse a rejected decision with the authorizer’s own sentence, and no decision at all', async () => {
    // Arrange
    const refusing = new ApiDispatcher(
      new ApiRouter([remedial()]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      authorizer({ allowed: false, refusal: 'an administrator has not allowed this warden to kill s-3' }),
    );
    const silent = new ApiDispatcher(
      new ApiRouter([remedial()]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      authorizer(undefined),
    );

    // Act
    const rejected = await refusing.dispatch(wardenRequest({ [WARDEN_CAPABILITY_HEADER]: 'cap-7' }));
    const undetermined = await silent.dispatch(wardenRequest({ [WARDEN_CAPABILITY_HEADER]: 'cap-7' }));

    // Assert — an undetermined answer is a refusal, never a permission.
    should(rejected.status).equal(403);
    should(jsonBody(rejected).code).equal('warden_remedy_refused');
    should(rejected.body).match(/an administrator has not allowed this warden to kill s-3/u);
    should(undetermined.status).equal(403);
    should(jsonBody(undetermined).code).equal('warden_remedy_undetermined');
  });

  it('should never render a blank refusal sentence as an opaque 403', async () => {
    // A refusal with nothing to say is an unfinished one, and rendering its empty sentence would
    // produce exactly the dead end this axis promises never to emit — only harder to notice than a
    // missing field, because the type is satisfied.
    // Arrange
    const dispatcher = new ApiDispatcher(
      new ApiRouter([remedial()]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      authorizer({ allowed: false, refusal: '  \n ' }),
    );

    // Act
    const response = await dispatcher.dispatch(wardenRequest({ [WARDEN_CAPABILITY_HEADER]: 'cap-7' }));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('warden_remedy_undetermined');
    should(String(jsonBody(response).error).trim()).not.be.empty();
    should(response.body).match(/an administrator must allow this remedy/u);
  });

  it('should refuse a warden presenting a capability on a route that declares no remedy', async () => {
    // Forgetting to declare must mean "the warden cannot act here", never "the warden acts unchecked".
    // Arrange
    const ordinary: ApiRoute = {
      method: 'POST',
      path: '/v1/sessions/:id/stop',
      minimum: 'authenticated',
      handle: async () => jsonResponse({ stopped: true }),
    };
    const dispatcher = new ApiDispatcher(new ApiRouter([ordinary]), credentials, NO_GOVERNED_ROUTES_GUARD, allowing());

    // Act
    const response = await dispatcher.dispatch(wardenRequest({ [WARDEN_CAPABILITY_HEADER]: 'cap-7' }));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('warden_remedy_undeclared');
    should(response.body).match(/declares no warden remedy/u);
  });

  it('should leave an ordinary authenticated warden read exactly as it was', async () => {
    // The axis is new; the surface a warden already reads is not. No declaration and no header means
    // this layer has nothing to say.
    // Arrange
    const seen: WardenRemedyPresentation[] = [];
    const dispatcher = new ApiDispatcher(
      new ApiRouter([echo('/v1/usage', 'authenticated')]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      allowing(seen),
    );

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/usage', headers: { authorization: 'Bearer warden-secret', [SESSION_ID_HEADER]: 'w-1' } }),
    );

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).actor).equal('warden:w-1');
    should(seen).be.empty();
  });

  it('should never let the remedy header turn an admin or a device into a warden', async () => {
    // THE LOAD-BEARING ONE. The header may refine WHICH warden is acting; it may never establish THAT
    // the caller is one. A credential that reaches a route on its own authority keeps that authority
    // and keeps its own attribution — the source flipped the class on a merely-present header, and an
    // admin's own actions were journalled as the warden's.
    // Arrange
    const seen: WardenRemedyPresentation[] = [];
    const dispatcher = new ApiDispatcher(
      new ApiRouter([remedial()]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      authorizer({ allowed: false, refusal: 'the authorizer must never be reached for these callers' }, seen),
    );

    // Act
    const asAdmin = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s-3/stop',
        headers: {
          authorization: 'Bearer admin-secret',
          [CLIENT_HEADER]: 'cli',
          [WARDEN_CAPABILITY_HEADER]: 'cap-7',
        },
      }),
    );
    const asDevice = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/sessions/s-3/stop',
        headers: { authorization: 'Bearer device-secret', [WARDEN_CAPABILITY_HEADER]: 'cap-7' },
      }),
    );

    // Assert
    should(asAdmin.status).equal(200);
    should(jsonBody(asAdmin).actor).equal('admin-cli');
    should(asDevice.status).equal(200);
    should(jsonBody(asDevice).actor).equal('device:device-1');
    should(seen).be.empty();
  });

  it('should ask the authorizer only AFTER the minimum, the arrival and the grant have all passed', async () => {
    // The remedy axis is independent, not superior: it cannot rescue a request the checks above it
    // refused, which is why there is no branch that reaches it from one of their failures.
    // Arrange — three routes a warden fails for three unrelated reasons, and an authorizer that would
    // allow anything if it were ever consulted.
    const seen: WardenRemedyPresentation[] = [];
    const belowMinimum = new ApiDispatcher(
      new ApiRouter([remedial('operator')]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      allowing(seen),
    );
    const privileged = new ApiDispatcher(
      new ApiRouter([{ ...remedial(), privilegedOnly: true }]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      allowing(seen),
    );
    const governed = new ApiDispatcher(
      new ApiRouter([{ ...remedial(), capability: { capability: 'warden', axis: 'use' } }]),
      credentials,
      {
        decide: () => ({ allowed: false, refusal: 'not-granted' }),
        explain: () => 'the operator of this machine has not granted the UI the use of the warden',
      },
      allowing(seen),
    );

    // Act
    const carrying = { [WARDEN_CAPABILITY_HEADER]: 'cap-7' };
    const refusedByMinimum = await belowMinimum.dispatch(wardenRequest(carrying));
    const refusedByArrival = await privileged.dispatch(wardenRequest(carrying));
    const refusedByGrant = await governed.dispatch(wardenRequest(carrying));

    // Assert
    should(refusedByMinimum.status).equal(403);
    should(jsonBody(refusedByMinimum).code).equal('forbidden');
    should(refusedByArrival.status).equal(403);
    should(jsonBody(refusedByArrival).code).equal('forbidden');
    should(refusedByGrant.status).equal(403);
    should(jsonBody(refusedByGrant).code).equal('grant_not_granted');
    should(seen).be.empty();
  });

  it('should not let the public shortcut carry a declared remedy past authentication', async () => {
    // The `none` shortcut answers before authentication is attempted, so it is a shortcut past EVERY
    // check below it. A route that declared both would otherwise be served to anyone at all with the
    // remedy unconsulted — the loudest possible version of the failure this axis exists to prevent.
    // Arrange
    const seen: WardenRemedyPresentation[] = [];
    const dispatcher = new ApiDispatcher(
      new ApiRouter([remedial('none')]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      allowing(seen),
    );

    // Act
    const anonymous = await dispatcher.dispatch(request({ method: 'POST', path: '/v1/sessions/s-3/stop' }));
    const unarmedWarden = await dispatcher.dispatch(wardenRequest());
    const armedWarden = await dispatcher.dispatch(wardenRequest({ [WARDEN_CAPABILITY_HEADER]: 'cap-7' }));

    // Assert — no token reaches it at all, and a warden still has to satisfy the remedy.
    should(anonymous.status).equal(401);
    should(jsonBody(anonymous).code).equal('unauthorized');
    should(unarmedWarden.status).equal(403);
    should(jsonBody(unarmedWarden).code).equal('warden_capability_required');
    should(armedWarden.status).equal(200);
    should(seen).have.length(1);
  });

  it('should fail closed on the shared boundary every other transport authorizes through', async () => {
    // The socket table authorizes through this same function and wires no authorizer today, so a
    // remedy declared over there must refuse rather than serve — and an ordinary route must keep
    // working exactly as it does now.
    // Arrange
    const router = new ApiRouter([remedial(), echo('/v1/usage', 'authenticated')]);

    // Act — five arguments, exactly as the socket boundary calls it.
    const declared = authorizeRequest(
      router,
      credentials,
      wardenRequest({ [WARDEN_CAPABILITY_HEADER]: 'cap-7' }),
      undefined,
      NO_GOVERNED_ROUTES_GUARD,
    );
    const ordinary = authorizeRequest(
      router,
      credentials,
      request({ path: '/v1/usage', headers: { authorization: 'Bearer warden-secret' } }),
      undefined,
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Assert
    should(declared.kind).equal('refused');
    should(declared.kind === 'refused' && jsonBody(declared.response).code).equal('warden_remedy_undetermined');
    should(ordinary.kind).equal('authorized');
  });
});
