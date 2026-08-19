import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import {
  DAEMON_CAPABILITIES,
  GRANT_UNLOCK_MAX_ATTEMPTS,
  GrantAuditViewSchema,
  GrantsViewSchema,
  GrantUnlockViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { grantRoutes } from '../../../../src/lib/runtime/mounts/grants.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, grantSubsystem, human } from './support.ts';

/**
 * The grant surface.
 *
 * IT IS NOT ITSELF CAPABILITY-GATED, and the first test says so: a restricted UI that could not read
 * the reason it is restricted is the greyed-control-with-no-explanation dead end this whole feature
 * exists to remove.
 */
async function mount(options: Parameters<typeof grantSubsystem>[0] = {}) {
  const subsystem = grantSubsystem(options);
  await subsystem.refresh();
  return {
    subsystem,
    dispatcher: new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD),
  };
}

/** A request that arrived from somewhere other than this host — the only caller grants govern. */
const remote = (path: string, headers: Record<string, string> = human) => request({ path, headers, loopback: false });

/** A body-carrying remote request; every write below is one. */
const post = (path: string, body: unknown, headers: Record<string, string> = human) =>
  request({ method: 'POST', path, headers, loopback: false, body: JSON.stringify(body) });

describe('the grant read', () => {
  it('should tell a governed caller what it may do and why, without a guard on itself', async () => {
    // Arrange
    const { dispatcher } = await mount({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, browser: { use: false, configure: false } },
    });

    // Act
    const answered = await dispatcher.dispatch(remote('/v1/grants'));

    // Assert
    should(answered.status).equal(200);
    const view = GrantsViewSchema.parse(jsonBody(answered));
    should(view.capabilities.find(entry => entry.capability === 'browser')).containDeep({
      use: false,
      useRefusal: 'not-granted',
    });
    should(view.passwordSet).be.false();
  });

  it('should never disclose the password in any form', async () => {
    // The entire disclosure is one boolean. `GET /v1/grants` is the route a paired device reads, so
    // this is where a leak would reach a browser.
    // Arrange
    const { dispatcher } = await mount({ password: 'operator-secret' });

    // Act
    const answered = await dispatcher.dispatch(remote('/v1/grants'));

    // Assert
    should(answered.body).not.match(/operator-secret/u);
    should(GrantsViewSchema.parse(jsonBody(answered))).have.property('passwordSet', true);
  });

  it('should refuse an unauthenticated reader', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const answered = await dispatcher.dispatch(request({ path: '/v1/grants', loopback: false }));

    // Assert
    should(answered.status).equal(401);
  });
});

describe('the unlock exchange', () => {
  it('should mint an unlock for the operator password', async () => {
    // Arrange
    const { dispatcher } = await mount({ password: 'operator-secret' });

    // Act
    const answered = await dispatcher.dispatch(post('/v1/grants/unlock', { password: 'operator-secret' }, human));

    // Assert
    should(answered.status).equal(200);
    should(GrantUnlockViewSchema.parse(jsonBody(answered)).token).match(/^fy_unlock_/u);
  });

  it('should say how many attempts are left, and nothing else about the password', async () => {
    // A limiter a person cannot see looks like a broken daemon; a limiter that says whether a guess
    // was close is not a limiter at all.
    // Arrange
    const { dispatcher } = await mount({ password: 'operator-secret' });

    // Act
    const answered = await dispatcher.dispatch(post('/v1/grants/unlock', { password: 'wrong' }, human));

    // Assert
    should(answered.status).equal(401);
    should(jsonBody(answered)).have.property('code', 'grant_wrong_password');
    should(answered.body).match(new RegExp(`${String(GRANT_UNLOCK_MAX_ATTEMPTS - 1)} attempts remaining`, 'u'));
  });

  it('should stop checking once the attempts are spent', async () => {
    // Arrange
    const { dispatcher } = await mount({ password: 'operator-secret' });

    // Act
    for (let attempt = 0; attempt < GRANT_UNLOCK_MAX_ATTEMPTS; attempt += 1) {
      await dispatcher.dispatch(post('/v1/grants/unlock', { password: 'wrong' }, human));
    }
    const answered = await dispatcher.dispatch(post('/v1/grants/unlock', { password: 'operator-secret' }, human));

    // Assert
    should(answered.status).equal(429);
    should(jsonBody(answered)).have.property('code', 'grant_rate_limited');
  });

  it('should refuse to unlock a machine that has no password to check', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const answered = await dispatcher.dispatch(post('/v1/grants/unlock', { password: 'anything' }, human));

    // Assert
    should(answered.status).equal(409);
    should(jsonBody(answered)).have.property('code', 'grant_no_password');
  });
});

describe('changing the grants over the API', () => {
  it('should record a narrowing change and answer with the new view', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const answered = await dispatcher.dispatch(
      request({
        method: 'PATCH',
        path: '/v1/grants',
        headers: human,
        loopback: false,
        body: JSON.stringify({ terminal: { use: false } }),
      }),
    );

    // Assert
    should(answered.status).equal(200);
    should(
      GrantsViewSchema.parse(jsonBody(answered)).capabilities.find(entry => entry.capability === 'terminal'),
    ).have.property('use', false);
  });

  it('should refuse a patch that changes nothing rather than reporting success for it', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const answered = await dispatcher.dispatch(
      request({ method: 'PATCH', path: '/v1/grants', headers: human, loopback: false, body: '{}' }),
    );

    // Assert
    should(answered.status).equal(400);
  });

  it('should report an undetermined document as unavailable rather than as a crash', async () => {
    // The daemon is working; it has lost the ANSWER, and the remedy is to repair the document.
    // Arrange
    const subsystem = grantSubsystem({ broken: true });
    await subsystem.refresh().catch(() => undefined);
    const dispatcher = new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const answered = await dispatcher.dispatch(
      request({
        method: 'PATCH',
        path: '/v1/grants',
        headers: human,
        loopback: false,
        body: JSON.stringify({ fleet: { use: false } }),
      }),
    );

    // Assert
    should(answered.status).equal(503);
    should(jsonBody(answered)).have.property('code', 'grants_undetermined');
  });
});

describe('the operator password route', () => {
  it('should require privileged arrival while allowing a local paired device', async () => {
    // The owner chose a local act, not an admin-token-only act. This lets the local UI explain the
    // requirement and keeps a remote bearer from rewriting the password.
    // Arrange
    const { subsystem } = await mount();
    const credentials = {
      ...CREDENTIALS,
      devices: { identify: (token: string) => (token === 'device-secret' ? 'device-1' : undefined) },
    };
    const withDevices = new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), credentials, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const remoteAdmin = await withDevices.dispatch(
      request({
        method: 'PUT',
        path: '/v1/grants/password',
        headers: human,
        loopback: false,
        body: JSON.stringify({ password: 'operator-secret' }),
      }),
    );
    const passwordAfterRemoteAdmin = subsystem.hasPassword();
    const localDevice = await withDevices.dispatch(
      request({
        method: 'PUT',
        path: '/v1/grants/password',
        headers: { authorization: 'Bearer device-secret' },
        loopback: true,
        body: JSON.stringify({ password: 'operator-secret' }),
      }),
    );
    const remoteDevice = await withDevices.dispatch(
      request({
        method: 'PUT',
        path: '/v1/grants/password',
        headers: { authorization: 'Bearer device-secret' },
        loopback: false,
        body: JSON.stringify({ password: 'stolen' }),
      }),
    );

    // Assert
    should(remoteAdmin.status).equal(403);
    should(passwordAfterRemoteAdmin).be.false();
    should(localDevice.status).equal(200);
    should(jsonBody(localDevice)).deepEqual({ passwordSet: true });
    should(subsystem.hasPassword()).be.true();
    should(remoteDevice.status).equal(403);
  });

  it('should refuse a LOCAL BROWSER holding no unlock, and serve the host token in the same state', async () => {
    // Both halves of the escape hatch, at the ROUTE rather than only in the subsystem, because this is
    // the boundary a real browser and a real `fy` meet.
    //
    // The browser is refused so the gate is not one tap wide. The admin token is served from the same
    // state — a password nobody presented and no unlock — because that is the door a FORGOTTEN password
    // is repaired through, and a design where both were closed would brick the machine forever.
    // Arrange — a machine with a password, and a device credential this dispatcher can identify.
    const { subsystem } = await mount({ password: 'the-one-nobody-remembers' });
    const credentials = {
      ...CREDENTIALS,
      devices: { identify: (token: string) => (token === 'device-secret' ? 'device-1' : undefined) },
    };
    const withDevices = new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), credentials, NO_GOVERNED_ROUTES_GUARD);
    const put = (headers: Record<string, string>, password: string) =>
      withDevices.dispatch(
        request({
          method: 'PUT',
          path: '/v1/grants/password',
          headers,
          loopback: true,
          body: JSON.stringify({ password }),
        }),
      );

    // Act
    const browser = await put({ authorization: 'Bearer device-secret' }, 'a-browser-tried-this');
    const hostToken = await put(human, 'the-host-repaired-it');

    // Assert
    should(browser.status).equal(403);
    should(jsonBody(browser)).have.property('code', 'grant_forbidden');
    // The refusal names the way back rather than saying only "forbidden".
    should(browser.body).match(/fy daemon password set/u);
    should(hostToken.status).equal(200);
    should(jsonBody(hostToken)).deepEqual({ passwordSet: true });
    // Recovery, proved: the password the host just set is the one that now unlocks.
    should(await subsystem.unlock('the-host-repaired-it')).have.property('kind', 'unlocked');
    // And nothing anywhere echoed either value back.
    should(browser.body).not.match(/a-browser-tried-this/u);
    should(hostToken.body).not.match(/the-host-repaired-it/u);
  });

  it('should refuse a body with no password at all, and an empty one, leaving the gate up', async () => {
    // AN ABSENT PASSWORD USED TO MEAN "REMOVE IT", and that is the hole this route no longer has: a
    // removal revokes nothing, so a machine with paired devices kept them and lost its gate. The schema
    // now requires the field, so `{}` is a 400 like any other malformed body rather than a second verb
    // hiding inside the first. `""` is refused by the minimum-length rule, as it always was.
    // Arrange
    const { dispatcher, subsystem } = await mount({ password: 'operator-secret' });

    // Act
    const blank = await dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/grants/password',
        headers: human,
        loopback: true,
        body: JSON.stringify({ password: '' }),
      }),
    );
    const absent = await dispatcher.dispatch(
      request({ method: 'PUT', path: '/v1/grants/password', headers: human, loopback: true, body: '{}' }),
    );

    // Assert
    should(blank.status).equal(400);
    should(absent.status).equal(400);
    // The gate survived both, which is the property that matters rather than the status codes.
    should(subsystem.hasPassword()).be.true();
    should(await subsystem.unlock('operator-secret')).have.property('kind', 'unlocked');
  });
});

describe('a failure that is not a grant refusal', () => {
  it('should become a server fault rather than being blamed on the caller', async () => {
    // The taxonomy only restates refusals the subsystem NAMED. Anything else is the daemon's fault,
    // and dressing a defect up as a 4xx sends the person looking at their own request.
    // Arrange
    const subsystem = grantSubsystem();
    await subsystem.refresh();
    const broken = {
      ...subsystem,
      refresh: async () => undefined,
      hasPassword: () => false,
      history: async (limit: number) => await subsystem.history(limit),
      view: (presentation: Parameters<typeof subsystem.view>[0]) => subsystem.view(presentation),
      unlock: async () => {
        throw new Error('the verifier file vanished mid-request');
      },
      patch: async () => {
        throw new Error('the document vanished mid-request');
      },
      setPassword: async () => undefined,
    };
    const dispatcher = new ApiDispatcher(new ApiRouter(grantRoutes(broken)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const unlocked = await dispatcher.dispatch(post('/v1/grants/unlock', { password: 'anything' }));
    const patched = await dispatcher.dispatch(
      request({
        method: 'PATCH',
        path: '/v1/grants',
        headers: human,
        loopback: false,
        body: JSON.stringify({ fleet: { use: false } }),
      }),
    );

    // Assert
    should(unlocked.status).equal(500);
    should(patched.status).equal(500);
  });
});

describe('the audit read', () => {
  it('should report who changed what, and not be gated on the grants it reports', async () => {
    // A caller refused a capability is exactly the caller who needs to know when and by whom it was
    // refused. Gating the history behind the decision would put the answer out of reach of the only
    // person asking the question.
    // Arrange — every capability switched off for a remote caller.
    const subsystem = grantSubsystem({
      grants: Object.fromEntries(
        DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false }]),
      ) as typeof DEFAULT_CAPABILITY_GRANTS,
    });
    await subsystem.refresh();
    await subsystem.patch({ fleet: { use: true } }, { loopback: true, adminToken: true, actor: 'admin-cli' });
    const dispatcher = new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const answered = await dispatcher.dispatch(remote('/v1/grants/audit'));

    // Assert
    should(answered.status).equal(200);
    const view = GrantAuditViewSchema.parse(jsonBody(answered));
    should(view.entries[0]).containDeep({ actor: 'admin-cli', changes: ['fleet.use=on'] });
    should(view.unreadable).equal(0);
  });

  it('should refuse a warden, which has no business learning which devices exist', async () => {
    // The grant READ is warden-scoped because a subject of a decision may read the decision. The
    // audit names DEVICES, which is a different disclosure.
    // Arrange
    const { subsystem } = await mount();
    const dispatcher = new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const answered = await dispatcher.dispatch(
      request({ path: '/v1/grants/audit', headers: { authorization: 'Bearer warden-secret' }, loopback: false }),
    );

    // Assert
    should(answered.status).equal(403);
  });
});
