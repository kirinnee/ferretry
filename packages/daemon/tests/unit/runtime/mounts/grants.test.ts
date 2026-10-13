import { describe, it } from 'bun:test';
import {
  DAEMON_CAPABILITIES,
  GRANT_AUDIT_MAX_ENTRIES,
  GrantAuditViewSchema,
  GrantsViewSchema,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD, type StepUpWitness } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import type { SessionDevice } from '../../../../src/lib/api/http.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { DEFAULT_CAPABILITY_GRANTS, GrantError } from '../../../../src/lib/grants/index.ts';
import { type GrantSubsystem, grantRoutes } from '../../../../src/lib/runtime/mounts/grants.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, grantSubsystem, human } from './support.ts';

/**
 * The grant surface.
 *
 * IT IS NOT ITSELF CAPABILITY-GATED, and the first test says so: a restricted UI that could not read
 * the reason it is restricted is the greyed-control-with-no-explanation dead end this whole feature
 * exists to remove.
 */
const PHONE: SessionDevice = { deviceId: 'device-phone', appSession: 'app-one' };
const OTHER_TAB: SessionDevice = { deviceId: 'device-phone', appSession: 'app-two' };

/** A witness that holds a step-up for exactly the device-and-app-session it names. */
const witnessFor = (...held: readonly SessionDevice[]): StepUpWitness => ({
  held: subject => held.some(entry => entry.deviceId === subject.deviceId && entry.appSession === subject.appSession),
});

function dispatcherFor(subsystem: GrantSubsystem, stepUps?: StepUpWitness): ApiDispatcher {
  return new ApiDispatcher(
    new ApiRouter(stepUps === undefined ? grantRoutes(subsystem) : grantRoutes(subsystem, stepUps)),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
}

async function mount(options: Parameters<typeof grantSubsystem>[0] = {}, stepUps?: StepUpWitness) {
  const subsystem = grantSubsystem(options);
  await subsystem.refresh();
  return { subsystem, dispatcher: dispatcherFor(subsystem, stepUps) };
}

/** A paired device across the relay, as the session that carried it proved. */
const fromDevice = (method: string, path: string, device: SessionDevice, body?: unknown) =>
  request({
    method,
    path,
    device,
    loopback: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The host command line: the admin token over loopback. */
const fromHost = (method: string, path: string, body?: unknown) =>
  request({
    method,
    path,
    headers: human,
    loopback: true,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('the routes this mount serves', () => {
  it('should serve the grant read, the audit read and the patch, and nothing else', () => {
    // The password and unlock routes are gone with the password itself.
    // Act
    const routes = grantRoutes(grantSubsystem()).map(route => `${route.method} ${route.path}`);

    // Assert
    should(routes).deepEqual(['GET /v1/grants', 'GET /v1/grants/audit', 'PATCH /v1/grants']);
  });

  it('should answer a deleted password route as unknown', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const password = await dispatcher.dispatch(fromHost('PUT', '/v1/grants/password', { password: 'x' }));
    const unlock = await dispatcher.dispatch(fromHost('POST', '/v1/grants/unlock', { password: 'x' }));

    // Assert
    should(password.status).equal(404);
    should(unlock.status).equal(404);
  });
});

describe('the grant read', () => {
  it('should tell a governed caller what it may do and why, without a guard on itself', async () => {
    // Arrange
    const { dispatcher } = await mount({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, browser: { use: false, configure: false } },
    });

    // Act
    const answered = await dispatcher.dispatch(fromDevice('GET', '/v1/grants', PHONE));

    // Assert
    should(answered.status).equal(200);
    should(answered.headers.get('cache-control')).match(/no-store/u);
    const view = GrantsViewSchema.parse(jsonBody(answered));
    should(view).containDeep({ governed: true, hostLocal: false, steppedUp: false });
    should(view.capabilities.find(entry => entry.capability === 'browser')).containDeep({
      use: false,
      useRefusal: 'not-granted',
    });
    should(view.capabilities.find(entry => entry.capability === 'fleet')).containDeep({
      configure: false,
      configureRefusal: 'step-up-required',
    });
    should(answered.body).not.match(/password|unlock/iu);
  });

  it('should report a device the witness holds as stepped up, and the same device in another tab as not', async () => {
    // A step-up belongs to one app session, so the dispatcher's witness is asked with BOTH halves.
    // Arrange
    const { dispatcher } = await mount({}, witnessFor(PHONE));

    // Act
    const held = GrantsViewSchema.parse(jsonBody(await dispatcher.dispatch(fromDevice('GET', '/v1/grants', PHONE))));
    const otherTab = GrantsViewSchema.parse(
      jsonBody(await dispatcher.dispatch(fromDevice('GET', '/v1/grants', OTHER_TAB))),
    );

    // Assert
    should(held.steppedUp).be.true();
    should(held.capabilities.every(entry => entry.configure)).be.true();
    should(otherTab.steppedUp).be.false();
  });

  it('should report no step-up for a caller with no device, even if the witness would say yes to anything', async () => {
    // A bearer caller — a warden, a remote admin token — proves no device, so there is nothing to ask.
    // Arrange
    const { dispatcher } = await mount({}, { held: () => true });

    // Act
    const warden = await dispatcher.dispatch(
      request({ path: '/v1/grants', headers: { authorization: 'Bearer warden-secret' }, loopback: false }),
    );

    // Assert
    should(warden.status).equal(200);
    should(GrantsViewSchema.parse(jsonBody(warden))).containDeep({ governed: true, steppedUp: false });
  });

  it('should report no step-up when the mount is built with no witness at all', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const view = GrantsViewSchema.parse(jsonBody(await dispatcher.dispatch(fromDevice('GET', '/v1/grants', PHONE))));

    // Assert
    should(view.steppedUp).be.false();
  });

  it('should report the host command line as ungoverned and host-local', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const view = GrantsViewSchema.parse(jsonBody(await dispatcher.dispatch(fromHost('GET', '/v1/grants'))));

    // Assert
    should(view).containDeep({ governed: false, hostLocal: true });
    should(view.capabilities.every(entry => entry.mayGrant)).be.true();
  });

  it('should treat a host-proven local browser as on the host, and a merely loopback peer as remote', async () => {
    // A loopback PEER is not the host: a locally bound proxy forwards a remote phone from one. Only the
    // carrier's proof (`privilegedLoopback`) makes a device-credentialed browser local.
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const proved = await dispatcher.dispatch(
      request({ path: '/v1/grants', device: PHONE, loopback: true, privilegedLoopback: true }),
    );
    const proxied = await dispatcher.dispatch(request({ path: '/v1/grants', device: PHONE, loopback: true }));

    // Assert
    should(GrantsViewSchema.parse(jsonBody(proved))).containDeep({ governed: false, hostLocal: true });
    should(GrantsViewSchema.parse(jsonBody(proxied))).containDeep({ governed: true, hostLocal: false });
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

describe('changing the grants over the API', () => {
  it('should ask a governed device to step up before it narrows', async () => {
    // Arrange
    const { dispatcher, subsystem } = await mount();

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', '/v1/grants', PHONE, { terminal: { use: false } }));

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', STEP_UP_REQUIRED_CODE);
    should(jsonBody(answered)).have.property('code', 'grant_step_up_required');
    should(answered.body).match(/passkey confirmation/u);
    should(subsystem.enforced()?.terminal.use).be.true();
  });

  it('should record a stepped-up narrowing and answer with the new view', async () => {
    // Arrange
    const { dispatcher, subsystem } = await mount({}, witnessFor(PHONE));

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', '/v1/grants', PHONE, { terminal: { use: false } }));

    // Assert
    should(answered.status).equal(200);
    should(
      GrantsViewSchema.parse(jsonBody(answered)).capabilities.find(entry => entry.capability === 'terminal'),
    ).have.property('use', false);
    should(subsystem.enforced()?.terminal.use).be.false();
    const history = await subsystem.history(1);
    should(history.entries[0]).containDeep({ actor: 'device:device-phone', changes: ['terminal.use=off'] });
  });

  it('should refuse a remote widening even with a step-up, as forbidden', async () => {
    // Arrange
    const { dispatcher } = await mount(
      { grants: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } } },
      witnessFor(PHONE),
    );

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', '/v1/grants', PHONE, { terminal: { use: true } }));

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', 'grant_forbidden');
    should(answered.body).match(/fy daemon config set terminal --use/u);
  });

  it('should let the host widen with no step-up', async () => {
    // Arrange
    const { dispatcher, subsystem } = await mount({
      grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: false, configure: false } },
    });

    // Act
    const answered = await dispatcher.dispatch(fromHost('PATCH', '/v1/grants', { pairing: { use: true } }));

    // Assert
    should(answered.status).equal(200);
    should(subsystem.enforced()?.pairing).deepEqual({ use: true, configure: false });
  });

  it('should refuse a warden the patch before the subsystem is asked', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const answered = await dispatcher.dispatch(
      request({
        method: 'PATCH',
        path: '/v1/grants',
        headers: { authorization: 'Bearer warden-secret' },
        loopback: false,
        body: JSON.stringify({ fleet: { use: false } }),
      }),
    );

    // Assert
    should(answered.status).equal(403);
    should(jsonBody(answered)).have.property('code', 'forbidden');
  });

  it('should refuse a patch that changes nothing rather than reporting success for it', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const answered = await dispatcher.dispatch(fromHost('PATCH', '/v1/grants', {}));

    // Assert
    should(answered.status).equal(400);
  });

  it('should report an undetermined document as unavailable rather than as a crash', async () => {
    // The daemon is working; it has lost the ANSWER, and the remedy is to repair the document.
    // Arrange
    const subsystem = grantSubsystem({ broken: true });
    await subsystem.refresh().catch(() => undefined);
    const dispatcher = dispatcherFor(subsystem, witnessFor(PHONE));

    // Act
    const answered = await dispatcher.dispatch(fromDevice('PATCH', '/v1/grants', PHONE, { fleet: { use: false } }));

    // Assert
    should(answered.status).equal(503);
    should(jsonBody(answered)).have.property('code', 'grants_undetermined');
  });
});

describe('a failure that is not a grant refusal', () => {
  it('should become a server fault rather than being blamed on the caller', async () => {
    // The taxonomy only restates refusals the subsystem NAMED. Anything else is the daemon's fault.
    // Arrange
    const subsystem = grantSubsystem();
    await subsystem.refresh();
    const broken: GrantSubsystem = {
      refresh: async () => undefined,
      view: presentation => subsystem.view(presentation),
      history: async () => {
        throw new Error('the journal vanished mid-request');
      },
      patch: async () => {
        throw new Error('the document vanished mid-request');
      },
    };
    const dispatcher = dispatcherFor(broken);

    // Act
    const patched = await dispatcher.dispatch(fromHost('PATCH', '/v1/grants', { fleet: { use: false } }));
    const audited = await dispatcher.dispatch(fromHost('GET', '/v1/grants/audit'));

    // Assert
    should(patched.status).equal(500);
    should(audited.status).equal(500);
  });

  it('should restate a named `invalid` refusal as a 400', async () => {
    // Arrange
    const subsystem = grantSubsystem();
    await subsystem.refresh();
    const invalid: GrantSubsystem = {
      refresh: async () => undefined,
      view: presentation => subsystem.view(presentation),
      history: async limit => await subsystem.history(limit),
      patch: async () => {
        throw new GrantError('invalid', 'that patch names nothing this daemon knows');
      },
    };

    // Act
    const answered = await dispatcherFor(invalid).dispatch(fromHost('PATCH', '/v1/grants', { fleet: { use: false } }));

    // Assert
    should(answered.status).equal(400);
    should(jsonBody(answered)).have.property('code', 'invalid_request');
  });
});

describe('the audit read', () => {
  it('should report who changed what, and not be gated on the grants it reports', async () => {
    // A caller refused a capability is exactly the caller who needs to know when and by whom.
    // Arrange — every capability switched off for a remote caller.
    const subsystem = grantSubsystem({
      grants: Object.fromEntries(
        DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false }]),
      ) as typeof DEFAULT_CAPABILITY_GRANTS,
    });
    await subsystem.refresh();
    await subsystem.patch(
      { fleet: { use: true } },
      { loopback: true, adminToken: true, actor: 'admin-cli', stepUp: false },
    );
    const dispatcher = dispatcherFor(subsystem);

    // Act
    const answered = await dispatcher.dispatch(fromDevice('GET', '/v1/grants/audit', PHONE));

    // Assert
    should(answered.status).equal(200);
    const view = GrantAuditViewSchema.parse(jsonBody(answered));
    should(view.entries[0]).containDeep({ actor: 'admin-cli', changes: ['fleet.use=on'] });
    should(view.unreadable).equal(0);
  });

  it('should ask the subsystem for the protocol window and no more', async () => {
    // Arrange
    const subsystem = grantSubsystem();
    await subsystem.refresh();
    const limits: number[] = [];
    const recording: GrantSubsystem = {
      refresh: async () => undefined,
      view: presentation => subsystem.view(presentation),
      patch: async (patch, presentation) => await subsystem.patch(patch, presentation),
      history: async limit => {
        limits.push(limit);
        return await subsystem.history(limit);
      },
    };

    // Act
    await dispatcherFor(recording).dispatch(fromHost('GET', '/v1/grants/audit'));

    // Assert
    should(limits).deepEqual([GRANT_AUDIT_MAX_ENTRIES]);
  });

  it('should refuse a warden, which has no business learning which devices exist', async () => {
    // Arrange
    const { dispatcher } = await mount();

    // Act
    const answered = await dispatcher.dispatch(
      request({ path: '/v1/grants/audit', headers: { authorization: 'Bearer warden-secret' }, loopback: false }),
    );

    // Assert
    should(answered.status).equal(403);
  });
});
