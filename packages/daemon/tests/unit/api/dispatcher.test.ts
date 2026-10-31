import { describe, it } from 'bun:test';
import { type CapabilityAxis, type DaemonCapability, StepUpRequiredBodySchema } from '@ferretry/protocol';
import should from 'should';
import {
  ApiDispatcher,
  ApiError,
  type ApiRoute,
  ApiRouter,
  ApiSocketDispatcher,
  type CallerGovernance,
  type CapabilityGuard,
  CLIENT_HEADER,
  type CredentialMinimum,
  finalised,
  jsonResponse,
  NO_GOVERNED_ROUTES_GUARD,
  NO_STEP_UP_WITNESS,
  SESSION_ID_HEADER,
  type SessionCredentialDirectory,
  type SessionCredentialRefusal,
  type SocketRoute,
  type StepUpWitness,
  WARDEN_CAPABILITY_HEADER,
  type WardenRemedyAuthorizer,
  type WardenRemedyDecision,
  type WardenRemedyGrant,
  type WardenRemedyPresentation,
} from '../../../src/lib/api/index.ts';
import { jsonBody, request } from './support.ts';

/**
 * Where the caller stands, for a stub whose subject is the DECISION rather than the gate.
 *
 * The boundary asks for this only on a route that names a capability, and only once the decision
 * above has already allowed the request — so every stub below answers with the caller this daemon
 * serves most, and a test that wanted a governed one would say so.
 */
const UNGOVERNED: CallerGovernance = {
  governed: false,
  decide: () => ({ allowed: true, refusal: 'granted' }),
};

const credentials = {
  admin: 'admin-secret',
  warden: 'warden-secret',
  devices: { has: (deviceId: string) => deviceId !== 'unpaired-device' },
};

/** A paired device, as a session proved it — the only way a device is ever a caller. */
const DEVICE = { deviceId: 'device-1', appSession: 'app-one' } as const;

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
    const remote = await dispatcher.dispatch(request({ path: '/healthz', loopback: false }));
    const loopback = await dispatcher.dispatch(request({ path: '/healthz', loopback: true }));

    // Assert
    should(remote.status).equal(200);
    should(jsonBody(remote).actor).be.null();
    should(loopback.status).equal(200);
    should(jsonBody(loopback).actor).be.null();
  });

  it('should refuse a remote caller to a public route requiring privileged arrival', async () => {
    // This route is deliberately anonymous: privileged arrival constrains WHERE it is served, not
    // which credential is presented. The public shortcut must therefore enforce locality itself.
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/local-healthz', 'none', 'GET', true));

    // Act
    const remote = await dispatcher.dispatch(
      request({ path: '/v1/local-healthz', loopback: false, privilegedLoopback: false }),
    );
    const loopback = await dispatcher.dispatch(
      request({ path: '/v1/local-healthz', loopback: true, privilegedLoopback: true }),
    );

    // Assert
    should(remote.status).equal(403);
    should(jsonBody(remote).code).equal('forbidden');
    should(loopback.status).equal(200);
    should(jsonBody(loopback).actor).be.null();
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

  it('should tell an app from before device keys to update, rather than that it was unpaired', async () => {
    // A bearer shaped like the old device token authenticates nothing — there is nothing left that could
    // compare one — and the answer says which side is old, in the sentence every surface shares.
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));
    const outdated = await dispatcher.dispatch(
      request({ path: '/v1/sessions', headers: { authorization: `Bearer fy_device_${'b'.repeat(43)}` } }),
    );
    const stranger = await dispatcher.dispatch(
      request({ path: '/v1/sessions', headers: { authorization: 'Bearer nope' } }),
    );

    should(outdated.status).equal(426);
    should(jsonBody(outdated)).containDeep({ code: 'app_outdated' });
    should(String(jsonBody(outdated).error)).match(/Reload the page/u);
    should(stranger.status).equal(401);
  });

  it('should tell an old app trying to pair over plain HTTP to update, rather than that its code is wrong', async () => {
    // The route is gone — redemption is a sealed record inside a session — so nothing serves it; it is
    // only answered in words, because a bare 401 would send that reader to mint a fresh code forever.
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'));
    const oldPairing = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/pair', body: '{"code":"7F3K-Q2ND","deviceName":"Old"}' }),
    );
    const otherVerb = await dispatcher.dispatch(request({ path: '/v1/pair' }));

    should(oldPairing.status).equal(426);
    should(jsonBody(oldPairing)).containDeep({ code: 'app_outdated' });
    should(otherVerb.status).equal(401);
  });

  it('should refuse a session device whose grant is gone, and every device when nobody can say', async () => {
    // A session proved its device when it opened; revoking the device ends the session. This is the
    // request-boundary half: a request already in flight for a device that no longer exists is refused.
    const gone = await dispatcherFor(echo('/v1/sessions', 'operator')).dispatch(
      request({ path: '/v1/sessions', device: { deviceId: 'unpaired-device', appSession: 'app-one' } }),
    );
    const unwired = await new ApiDispatcher(
      new ApiRouter([echo('/v1/sessions', 'operator')]),
      { admin: 'admin-secret' },
      NO_GOVERNED_ROUTES_GUARD,
    ).dispatch(request({ path: '/v1/sessions', device: DEVICE }));

    should(gone.status).equal(401);
    should(unwired.status).equal(401);
  });

  it('should refuse a shared-catalog member on every route of this table, a public one and an admin token included', async () => {
    // A member session is served by the member route table alone. The main table refuses it before the
    // public shortcut, before authentication and before the route's own scope is read.
    const MEMBER = { memberId: 'mbr_x', keyId: 'mk_x', appSession: 'app-one', sessionId: 'relay-1' } as const;
    const dispatcher = dispatcherFor(
      echo('/healthz', 'none'),
      echo('/v1/sessions', 'operator'),
      echo('/v1/admin', 'admin-token'),
    );

    for (const path of ['/healthz', '/v1/sessions', '/v1/admin', '/v1/nowhere']) {
      for (const carried of [{}, { loopback: true, privilegedLoopback: true }]) {
        const refused = await dispatcher.dispatch({ ...request({ path, ...carried }), member: MEMBER });

        should(refused.status).equal(403);
        should(jsonBody(refused).code).equal('forbidden');
      }
    }
    // The device path is untouched: the same route answers a device that is not a member.
    should((await dispatcher.dispatch(request({ path: '/v1/sessions', device: DEVICE }))).status).equal(200);
  });

  it('should let a paired device use operator routes but never an admin-token route', async () => {
    const dispatcher = dispatcherFor(echo('/v1/sessions', 'operator'), echo('/v1/pair/code', 'admin-token', 'POST'));

    const operator = await dispatcher.dispatch(request({ path: '/v1/sessions', device: DEVICE }));
    const hostOnly = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: '/v1/pair/code',
        device: DEVICE,
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
        device: DEVICE,
        loopback: true,
        privilegedLoopback: true,
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
        device: DEVICE,
        loopback: false,
      }),
    );

    should(localAdmin.status).equal(200);
    should(localDevice.status).equal(200);
    should(remoteAdmin.status).equal(403);
    should(remoteDevice.status).equal(403);
  });

  it('should refuse a privileged route to a device a local proxy forwarded, and keep the host admin', async () => {
    // `tailscale serve` and `cloudflared` forward a remote caller from a LOOPBACK peer, so a loopback
    // peer alone proved nothing: a paired phone behind one reached a host-only route. A device needs
    // the carrier's proof; the admin token is a host file, so holding it over loopback is enough — which
    // keeps the host command line working on a daemon bound beyond loopback.
    // Arrange
    const dispatcher = dispatcherFor(echo('/v1/local', 'operator', 'POST', true));
    const proxied = (token: string) =>
      request({ method: 'POST', path: '/v1/local', headers: { authorization: `Bearer ${token}` }, loopback: true });

    // Act
    const proxiedDevice = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/local', device: DEVICE, loopback: true }),
    );
    const hostAdmin = await dispatcher.dispatch(proxied('admin-secret'));

    // Assert
    should(proxiedDevice.status).equal(403);
    should(jsonBody(proxiedDevice).code).equal('forbidden');
    should(hostAdmin.status).equal(200);
  });

  it('should honour no query token, even for a loopback peer', async () => {
    // A token in a URL is logged by every proxy on the path and lands in argv and shell history.
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
    should(local.status).equal(401);
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
        device: DEVICE,
        headers: {
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

  it('should send what a route spells again as its last word, keeping the route cache policy', async () => {
    const route: ApiRoute = {
      method: 'GET',
      path: '/late',
      minimum: 'none',
      noStore: true,
      handle: async () => ({ ...jsonResponse({ shown: 'first' }), late: () => jsonResponse({ shown: 'last' }) }),
    };

    const response = await dispatcherFor(route).dispatch(request({ path: '/late' }));

    const sent = finalised(response);
    should(jsonBody(sent)).deepEqual({ shown: 'last' });
    should(sent.headers.get('cache-control')).equal('no-store');
  });

  it('should keep the last word on the response so a carrier can spell it again at its own hand-off', async () => {
    let spelled = 0;
    const route: ApiRoute = {
      method: 'GET',
      path: '/late',
      minimum: 'none',
      handle: async () => ({
        ...jsonResponse({ shown: 'first' }),
        late: () => jsonResponse({ shown: `spelling ${++spelled}` }),
      }),
    };

    const response = await dispatcherFor(route).dispatch(request({ path: '/late' }));
    await Promise.resolve();

    should(jsonBody(finalised(response))).deepEqual({ shown: 'spelling 2' });
    should(jsonBody(finalised(response))).deepEqual({ shown: 'spelling 3' });
  });

  it('should answer a refusal raised by a route last word like any other', async () => {
    const route: ApiRoute = {
      method: 'GET',
      path: '/late',
      minimum: 'none',
      handle: async () => ({
        ...jsonResponse({ shown: 'first' }),
        late: () => {
          throw new ApiError(409, 'held', 'conflict');
        },
      }),
    };

    const response = await dispatcherFor(route).dispatch(request({ path: '/late' }));

    should(response.status).equal(409);
    should(response.body).not.containEql('first');
    should(finalised(response).status).equal(409);
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
    governance: () => UNGOVERNED,
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
      governance: () => UNGOVERNED,
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
    // a client tell "the operator said no" from "confirm with your passkey" without parsing prose.
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

  it('should name the capability it refused when the guard has no sentence of its own', async () => {
    // A refusal with no explanation is the dead end the guard exists to remove, so the dispatcher
    // states the one fact it does know: which capability it will not serve.
    // Arrange
    const silent: CapabilityGuard = { ...guard(false), explain: () => undefined };
    const dispatcher = new ApiDispatcher(new ApiRouter([governed()]), credentials, silent);

    // Act
    const answered = await dispatcher.dispatch(
      request({ path: '/v1/fleet/plan', headers: { authorization: 'Bearer admin-secret' } }),
    );

    // Assert
    should(answered.status).equal(403);
    should(JSON.parse(answered.body)).containDeep({
      code: 'grant_not_granted',
      error: 'this daemon cannot say whether the UI may use fleet, so it is refusing',
    });
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

  it('should hand the guard the transport’s loopback answer and no header-borne authority', async () => {
    // `loopback` is the transport's own account of where the socket came from — a relayed hop is never
    // loopback — and nothing a caller writes into a header reaches the presentation.
    // Arrange
    const seen: Record<string, unknown>[] = [];
    const recording: CapabilityGuard = {
      decide: (_demand, presentation) => {
        seen.push({ ...presentation });
        return { allowed: true, refusal: 'granted' };
      },
      governance: () => UNGOVERNED,
      explain: () => undefined,
    };
    const dispatcher = new ApiDispatcher(new ApiRouter([governed()]), credentials, recording);

    // Act
    await dispatcher.dispatch(
      request({
        path: '/v1/fleet/plan',
        headers: { authorization: 'Bearer admin-secret', 'x-ferretry-step-up': 'true' },
        loopback: true,
      }),
    );

    // Assert — exactly four fields, and a bearer caller with no device has not stepped up.
    should(seen).deepEqual([
      { loopback: true, adminToken: true, actor: 'admin-ui', stepUp: false, freshStepUp: false },
    ]);
  });

  it('should present stepUp true for a device the witness holds and false for one it does not', async () => {
    // The step-up is the daemon's own record, keyed by the session's PROVEN device and its app session.
    // Arrange
    const asked: { deviceId: string; appSession: string }[] = [];
    const witness: StepUpWitness = {
      held: subject => {
        asked.push({ deviceId: subject.deviceId, appSession: subject.appSession });
        return subject.deviceId === DEVICE.deviceId && subject.appSession === DEVICE.appSession;
      },
    };
    const seen: boolean[] = [];
    const recording: CapabilityGuard = {
      decide: (_demand, presentation) => {
        seen.push(presentation.stepUp);
        return { allowed: true, refusal: 'granted' };
      },
      governance: () => UNGOVERNED,
      explain: () => undefined,
    };
    const dispatcher = new ApiDispatcher(new ApiRouter([governed()]), credentials, recording, undefined, witness);

    // Act
    await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: DEVICE }));
    await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: { ...DEVICE, appSession: 'app-two' } }));
    await dispatcher.dispatch(
      request({ path: '/v1/fleet/plan', device: { deviceId: 'device-2', appSession: 'app-one' } }),
    );
    await dispatcher.dispatch(request({ path: '/v1/fleet/plan', headers: { authorization: 'Bearer admin-secret' } }));

    // Assert — the deviceless caller never reaches the witness at all.
    should(seen).deepEqual([true, false, false, false]);
    should(asked).deepEqual([
      { deviceId: 'device-1', appSession: 'app-one' },
      { deviceId: 'device-1', appSession: 'app-two' },
      { deviceId: 'device-2', appSession: 'app-one' },
    ]);
  });

  it('should present no step-up for any device when no witness is wired', async () => {
    // Arrange
    const seen: boolean[] = [];
    const recording: CapabilityGuard = {
      decide: (_demand, presentation) => {
        seen.push(presentation.stepUp);
        return { allowed: true, refusal: 'granted' };
      },
      governance: () => UNGOVERNED,
      explain: () => undefined,
    };
    const dispatcher = new ApiDispatcher(new ApiRouter([governed()]), credentials, recording);

    // Act
    await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: DEVICE }));

    // Assert
    should(seen).deepEqual([false]);
    should(NO_STEP_UP_WITNESS.held(DEVICE)).be.false();
  });

  it('should refuse step-up-required with the guard’s sentence and the step-up wire code', async () => {
    // Arrange
    const refusing: CapabilityGuard = {
      decide: (_demand, presentation) =>
        presentation.stepUp ? { allowed: true, refusal: 'granted' } : { allowed: false, refusal: 'step-up-required' },
      governance: () => ({ governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) }),
      explain: () => 'using the agent fleet needs a passkey confirmation from this device.',
    };
    const dispatcher = new ApiDispatcher(new ApiRouter([governed()]), credentials, refusing, undefined, {
      held: subject => subject.appSession === 'app-one',
    });

    // Act
    const refused = await dispatcher.dispatch(
      request({ path: '/v1/fleet/plan', device: { ...DEVICE, appSession: 'app-two' } }),
    );
    const served = await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: DEVICE }));

    // Assert
    should(refused.status).equal(403);
    should(jsonBody(refused)).containDeep({
      code: 'grant_step_up_required',
      error: 'using the agent fleet needs a passkey confirmation from this device.',
    });
    should(served.status).equal(200);
  });

  it('should name the demand in a step-up refusal, for a use demand and for a configure demand, and nothing else', async () => {
    // Arrange — a guard that wants a step-up for everything, over two routes with different demands.
    const stepUpGuard: CapabilityGuard = {
      decide: () => ({ allowed: false, refusal: 'step-up-required' }),
      governance: () => UNGOVERNED,
      explain: () => 'a passkey confirmation is needed.',
    };
    const route = (path: string, capability: DaemonCapability, axis: CapabilityAxis): ApiRoute => ({
      method: 'GET',
      path,
      minimum: 'operator',
      capability: { capability, axis },
      handle: async () => jsonResponse({}),
    });
    const dispatcher = new ApiDispatcher(
      new ApiRouter([
        route('/v1/terminals/secret-name', 'terminal', 'use'),
        route('/v1/secrets', 'secrets', 'configure'),
      ]),
      credentials,
      stepUpGuard,
    );

    // Act
    const use = await dispatcher.dispatch(request({ path: '/v1/terminals/secret-name', device: DEVICE }));
    const configure = await dispatcher.dispatch(request({ path: '/v1/secrets', device: DEVICE }));

    // Assert — the closed pair, the existing envelope, and nothing taken from the request.
    should(use.status).equal(403);
    should(jsonBody(use)).deepEqual({
      error: 'a passkey confirmation is needed.',
      code: 'grant_step_up_required',
      demand: { capability: 'terminal', axis: 'use' },
    });
    should(JSON.stringify(jsonBody(use))).not.containEql('secret-name');
    should(StepUpRequiredBodySchema.safeParse(jsonBody(configure)).success).be.true();
    should(jsonBody(configure)).have.property('demand', { capability: 'secrets', axis: 'configure' });
  });

  it('should add no demand to a refusal that is not a step-up', async () => {
    // Arrange
    const dispatcher = new ApiDispatcher(new ApiRouter([governed()]), credentials, guard(false));

    // Act
    const refused = await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: DEVICE }));

    // Assert
    should(jsonBody(refused)).not.have.property('demand');
  });

  it('should present every device as remote, even on a host-proven carrier, and only the owner as local', async () => {
    // A PROXIED phone is a loopback peer, and a tunnel to a loopback-only bind is indistinguishable from
    // a browser on the host. So no device is ever the owner: only the host's admin token over loopback is
    // (owner decision, docs/design/zero-trust.md B4).
    // Arrange
    const seen: boolean[] = [];
    const recording: CapabilityGuard = {
      decide: (_demand, presentation) => {
        seen.push(presentation.loopback);
        return { allowed: true, refusal: 'granted' };
      },
      governance: () => UNGOVERNED,
      explain: () => undefined,
    };
    const dispatcher = new ApiDispatcher(new ApiRouter([governed()]), credentials, recording);

    // Act
    await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: DEVICE, loopback: true }));
    await dispatcher.dispatch(
      request({ path: '/v1/fleet/plan', device: DEVICE, loopback: true, privilegedLoopback: true }),
    );
    await dispatcher.dispatch(
      request({ path: '/v1/fleet/plan', headers: { authorization: 'Bearer admin-secret' }, loopback: true }),
    );

    // Assert
    should(seen).deepEqual([false, false, true]);
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
    handle: async context =>
      jsonResponse({
        actor: context.actor ?? null,
        params: [...context.params],
        grant: context.wardenRemedy ?? null,
      }),
  });

  /** The authority a satisfied authorizer mints: which remedy, over which session, by which warden. */
  const grant = (overrides: Partial<WardenRemedyGrant> = {}): WardenRemedyGrant => ({
    remedy: 'kill',
    targetSessionId: 's-3',
    wardenId: 'w-9',
    assignmentSpawnedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
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

  const allowing = (seen?: WardenRemedyPresentation[], minted: WardenRemedyGrant = grant()) =>
    authorizer({ allowed: true, grant: minted }, seen);

  const wardenRequest = (headers: Readonly<Record<string, string>> = {}) =>
    request({
      method: 'POST',
      path: '/v1/sessions/s-3/stop',
      headers: { authorization: 'Bearer warden-secret', [SESSION_ID_HEADER]: 'w-1', ...headers },
    });

  it('should serve a declared remedy to a warden the authorizer allows, and carry its grant onward', async () => {
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

    // Assert — the handler acts under an authority it could not have minted, naming a warden resolved
    // from the presented secret rather than from the session header the actor came from.
    should(response.status).equal(200);
    should(jsonBody(response).actor).equal('warden:w-1');
    should(jsonBody(response).grant).deepEqual({
      remedy: 'kill',
      targetSessionId: 's-3',
      wardenId: 'w-9',
      assignmentSpawnedAt: '2026-08-06T00:00:00.000Z',
    });
    should(seen).have.length(1);
    should(seen[0]?.remedy).equal('kill');
    should(seen[0]?.capability).equal('cap-7');
    should(seen[0]?.actor).equal('warden:w-1');
    should([...(seen[0]?.params ?? [])]).deepEqual([['id', 's-3']]);
  });

  it('should hand the authorizer FOUR fields and nothing that could carry a credential', async () => {
    // THE CONTRACT IS THE COUNT. The request was removed because its header map is the WHOLE header
    // map: a policy object would be handed the caller's live bearer, and nothing would stop a `decide` from reading a session header and deciding from it —
    // the header-movable authority this axis exists to close. Every field a policy CAN read is a
    // field it MIGHT decide from, so this pins the absences as hard as the presences.
    // Arrange
    const seen: WardenRemedyPresentation[] = [];
    const dispatcher = new ApiDispatcher(
      new ApiRouter([remedial()]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      allowing(seen),
    );

    // Act — every credential-bearing header this boundary knows about, presented at once.
    await dispatcher.dispatch(
      wardenRequest({
        [WARDEN_CAPABILITY_HEADER]: 'cap-7',
        [CLIENT_HEADER]: 'cli',
      }),
    );

    // Assert
    should(Object.keys(seen[0] ?? {}).sort()).deepEqual(['actor', 'capability', 'params', 'remedy']);
    for (const absent of ['request', 'method', 'path', 'loopback', 'headers', 'body', 'query', 'stepUp'])
      should(seen[0]).not.have.property(absent);
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
    should(jsonBody(carrying).code).equal('warden_remedy_invalid');
    should(carrying.body).match(/declares a blank warden remedy/u);
    should(bare.status).equal(403);
    should(jsonBody(bare).code).equal('warden_remedy_invalid');
    should(padded.status).equal(200);
    should(seen).have.length(1);
    should(seen[0]?.remedy).equal('kill');
  });

  it('should refuse an allowance whose grant cannot name what it authorized', async () => {
    // A grant is the evidence a destructive step names its warden by, so a blank field in one is not
    // a smaller grant — it is a grant that cannot do the one job it exists for. A remedy that
    // disagrees with the route's is worse: an authority minted for a different question.
    // Arrange
    const damaged = (overrides: Partial<WardenRemedyGrant>) =>
      new ApiDispatcher(
        new ApiRouter([remedial()]),
        credentials,
        NO_GOVERNED_ROUTES_GUARD,
        allowing(undefined, grant(overrides)),
      );

    // Act
    const carrying = { [WARDEN_CAPABILITY_HEADER]: 'cap-7' };
    const wrongRemedy = await damaged({ remedy: 'nudge' }).dispatch(wardenRequest(carrying));
    const noTarget = await damaged({ targetSessionId: ' ' }).dispatch(wardenRequest(carrying));
    const noWarden = await damaged({ wardenId: '' }).dispatch(wardenRequest(carrying));
    const noStamp = await damaged({ assignmentSpawnedAt: '  ' }).dispatch(wardenRequest(carrying));

    // Assert — all four are read as no decision at all rather than as a permission.
    for (const response of [wrongRemedy, noTarget, noWarden, noStamp]) {
      should(response.status).equal(403);
      should(jsonBody(response).code).equal('warden_remedy_undetermined');
    }
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

    // Assert — its OWN code: an unwired boundary is a packaging bug and belongs to a different person
    // than a daemon that has lost its own state.
    should(response.status).equal(403);
    should(jsonBody(response).code).equal('warden_remedy_unwired');
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
        headers: { [WARDEN_CAPABILITY_HEADER]: 'cap-7' },
        device: DEVICE,
      }),
    );

    // Assert — and neither carries a grant, so nothing downstream can mistake a forged header for
    // the authority a warden would have had to earn.
    should(jsonBody(asAdmin).grant).be.null();
    should(jsonBody(asDevice).grant).be.null();
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
        governance: () => UNGOVERNED,
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

  it('should ignore a warden capability presented to a public route that declares no remedy', async () => {
    // THE ONE EXCEPTION TO "a header on a route with no remedy is 403", and it is worth pinning
    // because it looks like a hole and is not. The shortcut answers a public route before any header
    // is inspected, so the capability is ignored rather than refused. Harmless in substance — anyone
    // at all may reach a public route, with or without a header nobody read.
    // Arrange
    const seen: WardenRemedyPresentation[] = [];
    const dispatcher = new ApiDispatcher(
      new ApiRouter([echo('/healthz', 'none')]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      allowing(seen),
    );

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/healthz', headers: { [WARDEN_CAPABILITY_HEADER]: 'cap-7' } }),
    );

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).actor).be.null();
    should(seen).be.empty();
  });

  it('should answer every remedy refusal with a code no other condition uses', async () => {
    // Distinct codes exist so a client can tell these apart WITHOUT parsing prose, and the thing
    // rendering them into something a human acts on has to say which of five different people fixes
    // it. A table catches a collision at authoring time; five sentences that differ only in wording
    // do not.
    // Arrange — every refusing condition, each with the smallest world that produces it.
    const undeclared: ApiRoute = {
      method: 'POST',
      path: '/v1/sessions/:id/stop',
      minimum: 'authenticated',
      handle: async () => jsonResponse({}),
    };
    const carrying = { [WARDEN_CAPABILITY_HEADER]: 'cap-7' };
    const conditions: readonly (readonly [string, ApiDispatcher, Readonly<Record<string, string>>])[] = [
      ['undeclared', new ApiDispatcher(new ApiRouter([undeclared]), credentials, NO_GOVERNED_ROUTES_GUARD), carrying],
      [
        'blank declaration',
        new ApiDispatcher(
          new ApiRouter([{ ...remedial(), wardenRemedy: ' ' }]),
          credentials,
          NO_GOVERNED_ROUTES_GUARD,
          allowing(),
        ),
        carrying,
      ],
      [
        'no capability',
        new ApiDispatcher(new ApiRouter([remedial()]), credentials, NO_GOVERNED_ROUTES_GUARD, allowing()),
        {},
      ],
      ['unwired', new ApiDispatcher(new ApiRouter([remedial()]), credentials, NO_GOVERNED_ROUTES_GUARD), carrying],
      [
        'no decision',
        new ApiDispatcher(new ApiRouter([remedial()]), credentials, NO_GOVERNED_ROUTES_GUARD, authorizer(undefined)),
        carrying,
      ],
      [
        'refused',
        new ApiDispatcher(
          new ApiRouter([remedial()]),
          credentials,
          NO_GOVERNED_ROUTES_GUARD,
          authorizer({ allowed: false, refusal: 'no administrator has allowed this' }),
        ),
        carrying,
      ],
    ];

    // Act
    const codes: string[] = [];
    for (const [, dispatcher, headers] of conditions) {
      const response = await dispatcher.dispatch(wardenRequest(headers));
      should(response.status).equal(403);
      codes.push(String(jsonBody(response).code));
    }

    // Assert — pairwise distinct, and every one of them says something.
    should(new Set(codes).size).equal(conditions.length);
    should(codes).deepEqual([
      'warden_remedy_undeclared',
      'warden_remedy_invalid',
      'warden_capability_required',
      'warden_remedy_unwired',
      'warden_remedy_undetermined',
      'warden_remedy_refused',
    ]);
  });

  it('should enforce the axis identically on the socket table, which is wired with the same authorizer', async () => {
    // `authorizeRequest`'s own contract is that warden scope is enforced the same way on BOTH tables.
    // An upgrade boundary that could not be wired would have refused with a sentence naming a fix
    // nobody could perform — an unsatisfiable instruction, and the exact "quietly missing dependency"
    // this class has already produced once.
    // Arrange
    const upgrade: SocketRoute = {
      method: 'POST',
      path: '/v1/sessions/:id/stop',
      minimum: 'authenticated',
      wardenRemedy: 'kill',
      accept: async () => async () => ({ open: async () => {}, fromClient: () => {}, close: () => {} }),
    };
    const wired = new ApiSocketDispatcher(new ApiRouter([upgrade]), credentials, NO_GOVERNED_ROUTES_GUARD, allowing());
    const unwired = new ApiSocketDispatcher(new ApiRouter([upgrade]), credentials, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const carrying = { [WARDEN_CAPABILITY_HEADER]: 'cap-7' };
    const accepted = await wired.upgrade(wardenRequest(carrying));
    const refused = await unwired.upgrade(wardenRequest(carrying));

    // Assert — no socket route is expected to declare a remedy, but if one does the answer is the
    // same one the request/response table gives, not an unanswerable refusal.
    should(accepted.outcome).equal('accepted');
    should(refused.outcome).equal('refused');
    should(refused.outcome === 'refused' && jsonBody(refused.response).code).equal('warden_remedy_unwired');
  });
});

describe('the explicit guard for a table that names no capability', () => {
  it('should fail closed on every question, so a table that grows one cannot acquire a bypass', () => {
    // A route table with no capability declaration never asks this guard anything. The value of the
    // constant is entirely in what it answers if one is ADDED and the wiring is not: refused, and a
    // caller reported as governed, with no axis allowed. It is asserted
    // directly because the dispatcher can never reach `governance` through it — `decide` refuses
    // first — and an unreachable fail-closed answer is exactly the kind that rots unnoticed.
    // Act
    const decision = NO_GOVERNED_ROUTES_GUARD.decide(
      { capability: 'fleet', axis: 'use' },
      { loopback: true, adminToken: true, actor: 'admin-cli', stepUp: true },
    );
    const governance = NO_GOVERNED_ROUTES_GUARD.governance({
      loopback: true,
      adminToken: true,
      actor: 'admin-cli',
      stepUp: true,
    });

    // Assert — the STRICTER reading of every field, for the most privileged caller there is.
    should(decision).deepEqual({ allowed: false, refusal: 'undetermined' });
    should(governance.governed).be.true();
    should(governance.decide({ capability: 'fleet', axis: 'configure' })).deepEqual({
      allowed: false,
      refusal: 'undetermined',
    });
    should(NO_GOVERNED_ROUTES_GUARD.explain({ capability: 'fleet', axis: 'use' }, 'undetermined')).be.undefined();
  });
});

describe('presence on opening', () => {
  const route = (path: string, unlockExempt?: true): ApiRoute => ({
    method: 'GET',
    path,
    minimum: 'operator',
    ...(unlockExempt === true ? { unlockExempt: true } : {}),
    handle: async () => jsonResponse({ served: path }),
  });

  /** A witness that wants presence from the named device only, recording every question. */
  const wanting = (deviceId: string, asked: string[] = []): StepUpWitness => ({
    held: () => false,
    unlockRequired: subject => {
      asked.push(subject.deviceId);
      return subject.deviceId === deviceId;
    },
  });

  const dispatcherWith = (witness: StepUpWitness) =>
    new ApiDispatcher(
      new ApiRouter([route('/v1/sessions'), route('/v1/passkeys', true)]),
      credentials,
      NO_GOVERNED_ROUTES_GUARD,
      undefined,
      witness,
    );

  it('should answer 401 unlock_required to a governed device before it is served anything', async () => {
    const answered = await dispatcherWith(wanting(DEVICE.deviceId)).dispatch(
      request({ path: '/v1/sessions', device: DEVICE }),
    );

    should(answered.status).equal(401);
    should(jsonBody(answered)).containDeep({ code: 'unlock_required' });
    should(answered.body).match(/confirm it is you with a passkey/u);
  });

  it('should still serve a device that does not need to confirm, and say nothing about the one that does', async () => {
    const dispatcher = dispatcherWith(wanting(DEVICE.deviceId));

    const confirmed = await dispatcher.dispatch(
      request({ path: '/v1/sessions', device: { deviceId: 'device-2', appSession: 'app-one' } }),
    );

    should(confirmed.status).equal(200);
  });

  it('should serve a route that carries the exemption, because that is how a device gives the confirmation', async () => {
    const served = await dispatcherWith(wanting(DEVICE.deviceId)).dispatch(
      request({ path: '/v1/passkeys', device: DEVICE }),
    );

    should(served.status).equal(200);
  });

  it('should not ask the witness about an exempt route at all', async () => {
    const asked: string[] = [];

    await dispatcherWith(wanting(DEVICE.deviceId, asked)).dispatch(request({ path: '/v1/passkeys', device: DEVICE }));

    should(asked).be.empty();
  });

  it("should ask a browser even when the carrier proved it local: only the owner's token is at the machine", async () => {
    // B4: a browser is never the owner, wherever it runs. The way back in is `fy` at the machine.
    const answered = await dispatcherWith(wanting(DEVICE.deviceId)).dispatch(
      request({ path: '/v1/sessions', device: DEVICE, loopback: true, privilegedLoopback: true }),
    );

    should(answered.status).equal(401);
  });

  it('should still ask a device on a loopback peer the carrier did not prove is the host', async () => {
    // A PROXIED phone is a loopback peer; only the carrier's proof moves it onto the host.
    const answered = await dispatcherWith(wanting(DEVICE.deviceId)).dispatch(
      request({ path: '/v1/sessions', device: DEVICE, loopback: true }),
    );

    should(answered.status).equal(401);
  });

  it('should never ask of a bearer caller, which has no passkey to give', async () => {
    const asked: string[] = [];

    const served = await dispatcherWith(wanting(DEVICE.deviceId, asked)).dispatch(
      request({ path: '/v1/sessions', headers: { authorization: 'Bearer admin-secret' } }),
    );

    should(served.status).equal(200);
    should(asked).be.empty();
  });

  it('should refuse an unauthenticated caller as unauthorized rather than as lacking presence', async () => {
    const asked: string[] = [];

    const answered = await dispatcherWith(wanting(DEVICE.deviceId, asked)).dispatch(request({ path: '/v1/sessions' }));

    should(jsonBody(answered)).containDeep({ code: 'unauthorized' });
    should(asked).be.empty();
  });

  it('should refuse a device whose grant is gone as unauthorized before asking about its presence', async () => {
    const asked: string[] = [];

    const answered = await dispatcherWith(wanting('unpaired-device', asked)).dispatch(
      request({ path: '/v1/sessions', device: { deviceId: 'unpaired-device', appSession: 'app-one' } }),
    );

    should(jsonBody(answered)).containDeep({ code: 'unauthorized' });
    should(asked).be.empty();
  });

  it('should serve everything when the witness has no opinion on presence', async () => {
    const served = await dispatcherWith({ held: () => false }).dispatch(
      request({ path: '/v1/sessions', device: DEVICE }),
    );

    should(served.status).equal(200);
    should(NO_STEP_UP_WITNESS.unlockRequired?.(DEVICE)).be.undefined();
  });

  it('should serve a device the witness says needs nothing', async () => {
    const served = await dispatcherWith({ held: () => false, unlockRequired: () => false }).dispatch(
      request({ path: '/v1/sessions', device: DEVICE }),
    );

    should(served.status).equal(200);
  });
});

describe('spending a single-use step-up', () => {
  const governedRoute = (): ApiRoute => ({
    method: 'GET',
    path: '/v1/fleet/plan',
    minimum: 'operator',
    capability: { capability: 'fleet', axis: 'use' },
    handle: async () => jsonResponse({ plan: [] }),
  });

  const guardDeciding = (decision: ReturnType<CapabilityGuard['decide']>): CapabilityGuard => ({
    decide: () => decision,
    governance: () => UNGOVERNED,
    explain: () => 'refused',
  });

  const witness = (spent: { deviceId: string; appSession: string }[]): StepUpWitness => ({
    held: () => true,
    spend: subject => {
      spent.push({ deviceId: subject.deviceId, appSession: subject.appSession });
    },
  });

  const dispatcherWithGuard = (guard: CapabilityGuard, stepUps: StepUpWitness) =>
    new ApiDispatcher(new ApiRouter([governedRoute()]), credentials, guard, undefined, stepUps);

  it('should spend the device’s step-up exactly once when an allowed act leaned on it', async () => {
    const spent: { deviceId: string; appSession: string }[] = [];
    const dispatcher = dispatcherWithGuard(
      guardDeciding({ allowed: true, refusal: 'granted', steppedUp: true }),
      witness(spent),
    );

    const served = await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: DEVICE }));

    should(served.status).equal(200);
    should(spent).deepEqual([{ deviceId: 'device-1', appSession: 'app-one' }]);
  });

  it('should spend once per act, so a second request cannot ride the first one’s confirmation', async () => {
    const spent: { deviceId: string; appSession: string }[] = [];
    const dispatcher = dispatcherWithGuard(
      guardDeciding({ allowed: true, refusal: 'granted', steppedUp: true }),
      witness(spent),
    );

    await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: DEVICE }));
    await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: DEVICE }));

    should(spent).have.length(2);
  });

  it('should not spend when the act needed no step-up', async () => {
    const spent: { deviceId: string; appSession: string }[] = [];
    const dispatcher = dispatcherWithGuard(guardDeciding({ allowed: true, refusal: 'granted' }), witness(spent));

    const served = await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: DEVICE }));

    should(served.status).equal(200);
    should(spent).be.empty();
  });

  it('should not spend a step-up on a refusal, which served nothing', async () => {
    const spent: { deviceId: string; appSession: string }[] = [];
    const dispatcher = dispatcherWithGuard(guardDeciding({ allowed: false, refusal: 'not-granted' }), witness(spent));

    const refused = await dispatcher.dispatch(request({ path: '/v1/fleet/plan', device: DEVICE }));

    should(refused.status).equal(403);
    should(spent).be.empty();
  });

  it('should not spend for a caller with no device, which can hold no step-up', async () => {
    const spent: { deviceId: string; appSession: string }[] = [];
    const dispatcher = dispatcherWithGuard(
      guardDeciding({ allowed: true, refusal: 'granted', steppedUp: true }),
      witness(spent),
    );

    const served = await dispatcher.dispatch(
      request({ path: '/v1/fleet/plan', headers: { authorization: 'Bearer admin-secret' } }),
    );

    should(served.status).equal(200);
    should(spent).be.empty();
  });

  describe('claiming the fresh proof at admission', () => {
    const claimingRoute = (claimed: boolean[], act?: 'catalog-install'): ApiRoute => ({
      method: 'POST',
      path: '/v1/claims',
      minimum: 'operator',
      capability: { capability: 'fleet', axis: 'use' },
      handle: async context => {
        claimed.push(context.claimFreshStepUp?.(act) === true);
        return jsonResponse({});
      },
    });
    const claimWitness = (proofs: { left: number }): StepUpWitness => ({
      held: () => true,
      claimFresh: () => {
        if (proofs.left <= 0) return false;
        proofs.left -= 1;
        return true;
      },
    });
    const dispatcherFor = (claimed: boolean[], witnessed: StepUpWitness, act?: 'catalog-install') =>
      new ApiDispatcher(
        new ApiRouter([claimingRoute(claimed, act)]),
        credentials,
        guardDeciding({ allowed: true, refusal: 'granted' }),
        undefined,
        witnessed,
      );

    it('should hand a route the device’s proof once, and nothing the second time', async () => {
      const claimed: boolean[] = [];
      const dispatcher = dispatcherFor(claimed, claimWitness({ left: 1 }));

      await dispatcher.dispatch(request({ method: 'POST', path: '/v1/claims', device: DEVICE }));
      await dispatcher.dispatch(request({ method: 'POST', path: '/v1/claims', device: DEVICE }));

      should(claimed).deepEqual([true, false]);
    });

    it('should ask the witness for a proof of the act the route names, and pass none when it names none', async () => {
      const asked: unknown[] = [];
      const witness: StepUpWitness = {
        held: () => true,
        claimFresh: (_subject, act) => {
          asked.push(act);
          return act === 'catalog-install';
        },
      };

      const named: boolean[] = [];
      await dispatcherFor(named, witness, 'catalog-install').dispatch(
        request({ method: 'POST', path: '/v1/claims', device: DEVICE }),
      );
      const unnamed: boolean[] = [];
      await dispatcherFor(unnamed, witness).dispatch(request({ method: 'POST', path: '/v1/claims', device: DEVICE }));

      should(asked).deepEqual(['catalog-install', undefined]);
      should([named, unnamed]).deepEqual([[true], [false]]);
    });

    it('should hold no proof for a caller with no device, even when the witness has one', async () => {
      const claimed: boolean[] = [];
      const dispatcher = dispatcherFor(claimed, claimWitness({ left: 1 }));

      await dispatcher.dispatch(
        request({ method: 'POST', path: '/v1/claims', headers: { authorization: 'Bearer admin-secret' } }),
      );

      should(claimed).deepEqual([false]);
    });

    it('should hold no proof when the witness cannot claim one', async () => {
      const claimed: boolean[] = [];
      const dispatcher = dispatcherFor(claimed, { held: () => true });

      await dispatcher.dispatch(request({ method: 'POST', path: '/v1/claims', device: DEVICE }));

      should(claimed).deepEqual([false]);
    });

    it('should never let the machine, or any proof minted so far, stand in for an act every caller must prove', async () => {
      // Arrange — a witness that would hand over a proof for anything, and a route asking for add-2fa-key
      const asked: unknown[] = [];
      const witness: StepUpWitness = {
        held: () => true,
        claimFresh: (_subject, act) => {
          asked.push(act);
          return true;
        },
      };
      const claimed: boolean[] = [];
      const stage = `st_${'a'.repeat(24)}`;
      const route: ApiRoute = {
        method: 'POST',
        path: '/v1/claims',
        minimum: 'operator',
        capability: { capability: 'fleet', axis: 'use' },
        handle: async context => {
          claimed.push(context.claimFreshStepUp?.('add-2fa-key', stage) === true);
          // @ts-expect-error — an act every caller must prove names the one subject its proof is bound to
          claimed.push(context.claimFreshStepUp?.('add-2fa-key') === true);
          return jsonResponse({});
        },
      };
      const dispatcher = (guard: CapabilityGuard) =>
        new ApiDispatcher(new ApiRouter([route]), credentials, guard, undefined, witness);

      // Act — a paired device, and the machine's own admin token (this guard answers every caller ungoverned)
      await dispatcher(guardDeciding({ allowed: true, refusal: 'granted' })).dispatch(
        request({ method: 'POST', path: '/v1/claims', device: DEVICE }),
      );
      await dispatcher(guardDeciding({ allowed: true, refusal: 'granted' })).dispatch(
        request({ method: 'POST', path: '/v1/claims', headers: { authorization: 'Bearer admin-secret' } }),
      );

      // Assert — refused every time, and no proof was spent on it
      should(claimed).deepEqual([false, false, false, false]);
      should(asked).deepEqual([]);
    });
  });

  it('should serve an allowed stepped-up act when the witness has nothing to spend', async () => {
    const served = await dispatcherWithGuard(guardDeciding({ allowed: true, refusal: 'granted', steppedUp: true }), {
      held: () => true,
    }).dispatch(request({ path: '/v1/fleet/plan', device: DEVICE }));

    should(served.status).equal(200);
  });
});

describe('ApiDispatcher legacy-use counting', () => {
  const legacyRoute: ApiRoute = { ...echo('/v1/old/:id', 'operator'), legacy: true };
  const admin = { authorization: 'Bearer admin-secret', 'x-ferretry-client': 'cli' } as const;

  const counted = (recorder: { record(hit: { route: string; clientVersion?: string }): void }, ...routes: ApiRoute[]) =>
    new ApiDispatcher(new ApiRouter(routes), credentials, NO_GOVERNED_ROUTES_GUARD, undefined, undefined, recorder);

  it('should record a legacy hit by its declared pattern with the client version', async () => {
    // Arrange
    const hits: Array<{ route: string; clientVersion?: string }> = [];
    const dispatcher = counted({ record: hit => hits.push(hit) }, legacyRoute);

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/old/abc', headers: { ...admin, 'x-fy-version': '4.108.0' }, loopback: true }),
    );

    // Assert
    should(response.status).equal(200);
    should(hits).deepEqual([{ route: 'GET /v1/old/:id', clientVersion: '4.108.0' }]);
  });

  it('should record a legacy hit without a version when the caller sent none', async () => {
    // Arrange
    const hits: Array<{ route: string; clientVersion?: string }> = [];
    const dispatcher = counted({ record: hit => hits.push(hit) }, legacyRoute);

    // Act
    await dispatcher.dispatch(request({ path: '/v1/old/abc', headers: admin, loopback: true }));

    // Assert
    should(hits).deepEqual([{ route: 'GET /v1/old/:id' }]);
  });

  it('should not record a route that is not marked legacy', async () => {
    // Arrange
    const hits: unknown[] = [];
    const dispatcher = counted({ record: hit => hits.push(hit) }, echo('/v1/new/:id', 'operator'));

    // Act
    await dispatcher.dispatch(request({ path: '/v1/new/abc', headers: admin, loopback: true }));

    // Assert
    should(hits).deepEqual([]);
  });

  it('should not record a hit that was refused, so a probe is not mistaken for a client', async () => {
    // Arrange
    const hits: unknown[] = [];
    const dispatcher = counted({ record: hit => hits.push(hit) }, legacyRoute);

    // Act
    const response = await dispatcher.dispatch(request({ path: '/v1/old/abc', loopback: false }));

    // Assert
    should(response.status).equal(401);
    should(hits).deepEqual([]);
  });

  it('should still serve the request when the counter throws', async () => {
    // Arrange
    const dispatcher = counted(
      {
        record: () => {
          throw new Error('the counter broke');
        },
      },
      legacyRoute,
    );

    // Act
    const response = await dispatcher.dispatch(request({ path: '/v1/old/abc', headers: admin, loopback: true }));

    // Assert
    should(response.status).equal(200);
  });

  it('should serve a legacy route where no counter is wired', async () => {
    // Arrange
    const dispatcher = dispatcherFor(legacyRoute);

    // Act
    const response = await dispatcher.dispatch(request({ path: '/v1/old/abc', headers: admin, loopback: true }));

    // Assert
    should(response.status).equal(200);
  });
});

describe('a ferret session credential at the boundary', () => {
  /** s-1's credential, in the shape every launch now mints. */
  const S1 = `fys_${'a'.repeat(43)}`;
  /** A credential whose session has stopped: the directory no longer answers for it. */
  const STOPPED = `fys_${'b'.repeat(43)}`;

  /** The directory the daemon wires, as a test can see it: what it was asked and what it was told. */
  function sessionsDirectory() {
    const asked: string[] = [];
    const refusals: SessionCredentialRefusal[] = [];
    const sessions: SessionCredentialDirectory = {
      resolve: async capability => {
        asked.push(capability);
        return capability === S1 ? { sessionId: 's-1' } : undefined;
      },
      refused: async refusal => {
        refusals.push(refusal);
      },
    };
    return { sessions, asked, refusals };
  }

  /** A route that must never be reached by these cases: reaching it is the failure. */
  const unreachable = (path: string, minimum: CredentialMinimum): ApiRoute => ({
    method: 'GET',
    path,
    minimum,
    handle: async () => {
      throw new Error(`a session credential reached ${path}`);
    },
  });

  function served(...routes: readonly ApiRoute[]) {
    const directory = sessionsDirectory();
    const dispatcher = new ApiDispatcher(
      new ApiRouter(routes),
      { ...credentials, sessions: directory.sessions },
      NO_GOVERNED_ROUTES_GUARD,
    );
    return { ...directory, dispatcher };
  }

  /** As a pane presents it: from this machine, over the privileged loopback carrier. */
  const asSession = (path: string, credential: string, headers: Readonly<Record<string, string>> = {}) =>
    request({
      path,
      loopback: true,
      privilegedLoopback: true,
      headers: { authorization: `Bearer ${credential}`, ...headers },
    });

  it('should refuse a session credential on every route it authenticates, as if it were anonymous', async () => {
    // Until the route table says per route who may call it, the one route a session credential reaches is
    // the public agent-tools route, which reads it itself. Every minimum is covered, so "operator" — which
    // the admin token and a device meet — cannot be met by one by accident.
    // Arrange
    const { dispatcher, asked, refusals } = served(
      unreachable('/v1/authenticated', 'authenticated'),
      unreachable('/v1/operator', 'operator'),
      unreachable('/v1/admin', 'admin-token'),
    );

    // Act
    const responses = await Promise.all(
      ['/v1/authenticated', '/v1/operator', '/v1/admin'].map(
        async path => await dispatcher.dispatch(asSession(path, S1)),
      ),
    );

    // Assert — the credential WAS recognised (one lookup each), and refused all the same, unaudited.
    should(responses.map(response => [response.status, jsonBody(response).code])).deepEqual([
      [401, 'unauthorized'],
      [401, 'unauthorized'],
      [401, 'unauthorized'],
    ]);
    should(asked).deepEqual([S1, S1, S1]);
    should(refusals).deepEqual([]);
  });

  it('should not let a session header relabel a session credential, and audit the attempt', async () => {
    // The credential names its session. A header naming another one is a forged attribution: refused as
    // `session_mismatch`, and the audit log is told which session the CREDENTIAL named.
    // Arrange
    const { dispatcher, refusals } = served(unreachable('/v1/sessions', 'operator'));

    // Act
    const relabelled = await dispatcher.dispatch(asSession('/v1/sessions', S1, { [SESSION_ID_HEADER]: 's-2' }));
    const agreeing = await dispatcher.dispatch(asSession('/v1/sessions', S1, { [SESSION_ID_HEADER]: 's-1' }));

    // Assert — agreeing earns nothing either: it is still a session credential on a route that takes none.
    should(relabelled.status).equal(401);
    should(jsonBody(relabelled).code).equal('session_mismatch');
    should(agreeing.status).equal(401);
    should(jsonBody(agreeing).code).equal('unauthorized');
    should(refusals).deepEqual([{ reason: 'session_mismatch', sessionId: 's-1', route: 'GET /v1/sessions' }]);
  });

  it('should answer a relabel the same way when the audit write fails', async () => {
    // An audit write never decides an outcome: a log that cannot be written must not turn a refusal into
    // a 500, or into anything a caller could tell apart.
    // Arrange
    const sessions: SessionCredentialDirectory = {
      resolve: async capability => (capability === S1 ? { sessionId: 's-1' } : undefined),
      refused: async () => await Promise.reject(new Error('the audit log is full')),
    };
    const dispatcher = new ApiDispatcher(
      new ApiRouter([unreachable('/v1/sessions', 'operator')]),
      { ...credentials, sessions },
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Act
    const response = await dispatcher.dispatch(asSession('/v1/sessions', S1, { [SESSION_ID_HEADER]: 's-2' }));

    // Assert
    should(response.status).equal(401);
    should(jsonBody(response).code).equal('session_mismatch');
  });

  it('should not let a warden capability or a client header make a session credential anything else', async () => {
    // Arrange
    const { dispatcher } = served(unreachable('/v1/sessions', 'authenticated'));

    // Act
    const response = await dispatcher.dispatch(
      asSession('/v1/sessions', S1, { [WARDEN_CAPABILITY_HEADER]: 'cap-7', [CLIENT_HEADER]: 'cli' }),
    );

    // Assert
    should(response.status).equal(401);
    should(jsonBody(response).code).equal('unauthorized');
  });

  it('should answer a live and a dead session credential in the same words, so neither is an oracle', async () => {
    // Arrange
    const { dispatcher } = served(unreachable('/v1/sessions', 'authenticated'));

    // Act
    const live = await dispatcher.dispatch(asSession('/v1/sessions', S1));
    const dead = await dispatcher.dispatch(asSession('/v1/sessions', STOPPED));
    const stranger = await dispatcher.dispatch(request({ path: '/v1/sessions', privilegedLoopback: true }));

    // Assert
    should(live.status).equal(dead.status);
    should(jsonBody(live)).deepEqual(jsonBody(dead));
    should(jsonBody(live)).deepEqual(jsonBody(stranger));
  });

  it('should never look a session credential up when it arrived from anywhere but this machine', async () => {
    // A pane presents its credential from this host only. From a remote carrier — the tunnel listener, a LAN
    // bind, a locally bound proxy that cannot prove the peer is this machine — it is a stranger's bearer:
    // no session reads, no liveness answer, and no audit record a header could make it write.
    // Arrange
    const { dispatcher, asked, refusals } = served(unreachable('/v1/sessions', 'authenticated'));
    const remote = (headers: Readonly<Record<string, string>> = {}) =>
      request({ path: '/v1/sessions', loopback: false, headers: { authorization: `Bearer ${S1}`, ...headers } });
    const unprovenLoopback = request({
      path: '/v1/sessions',
      loopback: true,
      privilegedLoopback: false,
      headers: { authorization: `Bearer ${S1}` },
    });

    // Act
    const plain = await dispatcher.dispatch(remote());
    const relabelled = await dispatcher.dispatch(remote({ [SESSION_ID_HEADER]: 's-2' }));
    const proxied = await dispatcher.dispatch(unprovenLoopback);

    // Assert
    should([plain.status, relabelled.status, proxied.status]).deepEqual([401, 401, 401]);
    should(jsonBody(relabelled).code).equal('unauthorized');
    should(asked).deepEqual([]);
    should(refusals).deepEqual([]);
  });

  it("should answer a stopped session's credential as anonymous, whatever header it carries", async () => {
    // Arrange
    const { dispatcher, refusals } = served(unreachable('/v1/sessions', 'authenticated'));

    // Act
    const response = await dispatcher.dispatch(asSession('/v1/sessions', STOPPED, { [SESSION_ID_HEADER]: 's-2' }));

    // Assert — not `session_mismatch`: a credential that names no live session names nobody to mismatch.
    should(response.status).equal(401);
    should(jsonBody(response).code).equal('unauthorized');
    should(refusals).deepEqual([]);
  });

  it('should not name a route back to a session credential, known or unknown', async () => {
    // Arrange
    const { dispatcher } = served(unreachable('/v1/sessions', 'authenticated'));

    // Act
    const unknown = await dispatcher.dispatch(asSession('/v1/nowhere', S1));
    const wrongVerb = await dispatcher.dispatch(
      request({ method: 'DELETE', path: '/v1/sessions', headers: { authorization: `Bearer ${S1}` } }),
    );

    // Assert — 401 rather than 404 or 405, exactly as for a stranger.
    should([unknown.status, wrongVerb.status]).deepEqual([401, 401]);
  });

  it('should leave a public route to read its own credential, so the directory is asked once, there', async () => {
    // Arrange
    const { dispatcher, asked } = served(echo('/v1/public', 'none'));

    // Act
    const response = await dispatcher.dispatch(asSession('/v1/public', S1));

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response).actor).be.null();
    should(asked).deepEqual([]);
  });

  it('should keep the admin token the admin token, beside a session-shaped header or none', async () => {
    // The honest-client path every pane from before this release still takes: admin bearer plus the
    // pane's session id is the peer, exactly as before.
    // Arrange
    const { dispatcher, asked } = served(echo('/v1/sessions', 'operator'));

    // Act
    const response = await dispatcher.dispatch(
      request({ path: '/v1/sessions', headers: { authorization: 'Bearer admin-secret', [SESSION_ID_HEADER]: 's-1' } }),
    );

    // Assert
    should(jsonBody(response).actor).equal('peer:s-1');
    should(asked).deepEqual([]);
  });

  it('should refuse a session credential on the socket table too, and audit a relabel there', async () => {
    // Arrange
    const directory = sessionsDirectory();
    const upgrade: SocketRoute = {
      method: 'GET',
      path: '/v1/sessions/:id/stream',
      minimum: 'authenticated',
      accept: async () => {
        throw new Error('a session credential reached a socket');
      },
    };
    const sockets = new ApiSocketDispatcher(
      new ApiRouter([upgrade]),
      { ...credentials, sessions: directory.sessions },
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Act
    const plain = await sockets.upgrade(asSession('/v1/sessions/x/stream', S1));
    const relabelled = await sockets.upgrade(asSession('/v1/sessions/x/stream', S1, { [SESSION_ID_HEADER]: 's-2' }));

    // Assert
    should(plain.outcome === 'refused' && plain.response.status).equal(401);
    should(relabelled.outcome === 'refused' && jsonBody(relabelled.response).code).equal('session_mismatch');
    should(directory.refusals).have.length(1);
  });
});
