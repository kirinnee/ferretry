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
  return { subsystem, dispatcher: new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), CREDENTIALS) };
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
    const dispatcher = new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), CREDENTIALS);

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
  it('should set a password from the host and refuse a paired device outright', async () => {
    // A device that could clear the password could remove its own gate, which would make the whole
    // layer advisory. `host` scope is the host's own admin token and nothing else.
    // Arrange
    const { dispatcher, subsystem } = await mount();
    const credentials = {
      ...CREDENTIALS,
      devices: { identify: (token: string) => (token === 'device-secret' ? 'device-1' : undefined) },
    };
    const withDevices = new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), credentials);

    // Act
    const set = await dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/grants/password',
        headers: human,
        loopback: false,
        body: JSON.stringify({ password: 'operator-secret' }),
      }),
    );
    const byDevice = await withDevices.dispatch(
      request({
        method: 'PUT',
        path: '/v1/grants/password',
        headers: { authorization: 'Bearer device-secret' },
        loopback: false,
        body: JSON.stringify({ password: 'stolen' }),
      }),
    );

    // Assert
    should(set.status).equal(200);
    should(jsonBody(set)).deepEqual({ passwordSet: true });
    should(subsystem.hasPassword()).be.true();
    should(byDevice.status).equal(403);
  });

  it('should clear the password when none is supplied, and refuse an empty one', async () => {
    // Absence clears; `""` is a client bug and must fail the minimum-length rule rather than
    // silently disarming the gate.
    // Arrange
    const { dispatcher, subsystem } = await mount({ password: 'operator-secret' });

    // Act
    const blank = await dispatcher.dispatch(
      request({
        method: 'PUT',
        path: '/v1/grants/password',
        headers: human,
        loopback: false,
        body: JSON.stringify({ password: '' }),
      }),
    );
    const cleared = await dispatcher.dispatch(
      request({ method: 'PUT', path: '/v1/grants/password', headers: human, loopback: false, body: '{}' }),
    );

    // Assert
    should(blank.status).equal(400);
    should(cleared.status).equal(200);
    should(jsonBody(cleared)).deepEqual({ passwordSet: false });
    should(subsystem.hasPassword()).be.false();
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
    const dispatcher = new ApiDispatcher(new ApiRouter(grantRoutes(broken)), CREDENTIALS);

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
    await subsystem.patch({ fleet: { use: true } }, { loopback: true, actor: 'admin-cli' });
    const dispatcher = new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), CREDENTIALS);

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
    const dispatcher = new ApiDispatcher(new ApiRouter(grantRoutes(subsystem)), CREDENTIALS);

    // Act
    const answered = await dispatcher.dispatch(
      request({ path: '/v1/grants/audit', headers: { authorization: 'Bearer warden-secret' }, loopback: false }),
    );

    // Assert
    should(answered.status).equal(403);
  });
});
