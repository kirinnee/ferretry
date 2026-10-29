import { describe, it } from 'bun:test';
import {
  type CapabilityGrants,
  LIMITED_DEVICE_GRANTS,
  type PushDeviceView,
  type RegisterPushDeviceRequest,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../../../../src/lib/grants/index.ts';
import { PushError } from '../../../../src/lib/push/index.ts';
import { type PushSubscriptionSubsystem, pushRoutes } from '../../../../src/lib/runtime/mounts/push.ts';
import { jsonBody, request } from '../../api/support.ts';
import { grantSubsystem } from './support.ts';

const AT = '2026-08-05T09:00:00.000Z';
const deviceId = `fy_device_id_${'d'.repeat(22)}`;
const otherDeviceId = `fy_device_id_${'e'.repeat(22)}`;
const enrolmentId = 'push-11111111-1111-4111-8111-111111111111';

const view = (id: string, deviceName: string): PushDeviceView => ({
  id,
  deviceName,
  createdAt: AT,
  updatedAt: AT,
  expirationTime: null,
});

const body: RegisterPushDeviceRequest = {
  deviceName: 'Pixel 8',
  subscription: {
    endpoint: 'https://fcm.googleapis.com/send/one',
    expirationTime: null,
    keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 4).toString('base64url') },
  },
};

/**
 * A push subsystem that records who asked for what.
 *
 * The OWNING DEVICE is what this fixture exists to capture. The whole reason the mount reads it from
 * the authorization boundary instead of the body is that a browser must not be able to file an
 * enrolment against a device it does not hold, and the only way to prove the mount passes the right
 * one through is to record what the subsystem was handed.
 */
class FakePush implements PushSubscriptionSubsystem {
  readonly registrations: Array<readonly [string, RegisterPushDeviceRequest]> = [];
  readonly revocations: string[] = [];

  constructor(
    private readonly enrolled: readonly PushDeviceView[] = [view(enrolmentId, 'Pixel 8')],
    /** The refusal every call raises, when a case is driving one. */
    private readonly refusal?: PushError,
    /** Who filed each enrolment; every enrolment is the browser's own unless a case says otherwise. */
    private readonly owners: ReadonlyMap<string, string> = new Map(),
  ) {}

  async publicKey(): Promise<string> {
    if (this.refusal !== undefined) throw this.refusal;
    return Buffer.alloc(65, 4).toString('base64url');
  }

  async list(): Promise<readonly PushDeviceView[]> {
    if (this.refusal !== undefined) throw this.refusal;
    return this.enrolled;
  }

  async listFor(owner: string): Promise<readonly PushDeviceView[]> {
    if (this.refusal !== undefined) throw this.refusal;
    return this.enrolled.filter(entry => (this.owners.get(entry.id) ?? deviceId) === owner);
  }

  async ownerOf(id: string): Promise<string | undefined> {
    if (this.refusal !== undefined) throw this.refusal;
    return this.enrolled.some(entry => entry.id === id) ? (this.owners.get(id) ?? deviceId) : undefined;
  }

  async register(owner: string, input: RegisterPushDeviceRequest): Promise<PushDeviceView> {
    this.registrations.push([owner, input]);
    if (this.refusal !== undefined) throw this.refusal;
    return view(enrolmentId, input.deviceName);
  }

  async revoke(id: string): Promise<PushDeviceView> {
    this.revocations.push(id);
    if (this.refusal !== undefined) throw this.refusal;
    const found = this.enrolled.find(entry => entry.id === id);
    if (found === undefined) throw new PushError('not_found', 'no push enrolment with that id');
    return found;
  }
}

const credentials = {
  admin: 'admin-secret',
  warden: 'warden-secret',
  devices: {
    has: (deviceId: string) => deviceId !== 'unpaired-device',
    // A DEFAULT device — `fleet.use` only — because self-enrolment must work on one (B5).
    grants: (_deviceId: string) => deviceGrants,
  },
};
let deviceGrants: CapabilityGrants = LIMITED_DEVICE_GRANTS;

const admin = { authorization: 'Bearer admin-secret' };
/** A paired browser: whoever its session proved. It sends no credential of its own. */
const browser = { deviceId, appSession: 'app-one' } as const;
const warden = { authorization: 'Bearer warden-secret' };

/**
 * The mount over the REAL grant subsystem.
 *
 * Real rather than a stub guard, because the property under test is that these routes are governed by
 * the same object the operator's document feeds. `pairing` is permissive by default, so `allow: false`
 * is how a fixture states that the operator switched device management off for remote callers.
 *
 * Enrolment is `pairing.use`, which a remote caller reaches only with a live passkey step-up, so the
 * paired browser here holds one: these cases are about what the routes do once the gate is passed.
 */
async function mount(subject: PushSubscriptionSubsystem, allow = true) {
  const grants = grantSubsystem({
    grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: allow, configure: allow } },
  });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(pushRoutes(subject, grants)), credentials, grants, undefined, {
    held: device => device.deviceId === browser.deviceId,
  });
}

describe('push routes', () => {
  it('should ask a governed device for a passkey confirmation before it enrols, naming the act, and store nothing', async () => {
    // Enrolling makes this host send requests to the endpoint, now and on every alert (review M2).
    const subject = new FakePush();
    const unconfirmed = { deviceId: otherDeviceId, appSession: 'app-two' } as const;

    const response = await (
      await mount(subject)
    ).dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', device: unconfirmed, body: JSON.stringify(body) }),
    );

    should(response.status).equal(403);
    should(jsonBody(response)).containDeep({
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'pairing', axis: 'use' },
    });
    should(subject.registrations).be.empty();
  });

  it('should answer a paired browser with the application-server key, cacheable because it is public', async () => {
    const subject = new FakePush();

    const response = await (
      await mount(subject)
    ).dispatch(request({ method: 'GET', path: '/v1/push/vapid', device: browser }));

    should(response.status).equal(200);
    // One stable public point per daemon. A browser re-reads it on every enrolment attempt, so a
    // cached copy is the correct answer rather than a stale one.
    should(response.headers.get('cache-control')).equal(undefined);
    should(jsonBody(response)).deepEqual({ publicKey: Buffer.alloc(65, 4).toString('base64url') });
  });

  it('should list enrolments without ever putting an endpoint on the wire', async () => {
    const subject = new FakePush([view(enrolmentId, 'Pixel 8')]);

    const response = await (
      await mount(subject)
    ).dispatch(request({ method: 'GET', path: '/v1/push/subscriptions', device: browser }));

    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual({ devices: [view(enrolmentId, 'Pixel 8')] });
    should(response.body).not.match(/fcm\.googleapis\.com/u);
  });

  it('should file an enrolment against the CALLER, with no way for a body to claim otherwise', async () => {
    const subject = new FakePush();
    const surface = await mount(subject);

    const enrolled = await surface.dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', device: browser, body: JSON.stringify(body) }),
    );
    // The request shape is strict, so a body that tries to name a different owner is not merely
    // ignored — it is refused. There is nowhere on this wire to claim a device.
    const claiming = await surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/push/subscriptions',
        device: browser,
        body: JSON.stringify({ ...body, deviceId: otherDeviceId }),
      }),
    );

    should(enrolled.status).equal(201);
    should(claiming.status).equal(400);
    should(subject.registrations.map(([owner]) => owner)).deepEqual([deviceId]);
    should(jsonBody(enrolled)).deepEqual(view(enrolmentId, 'Pixel 8'));
  });

  it('should refuse an enrolment from a credential that is not a paired device', async () => {
    const subject = new FakePush();
    const surface = await mount(subject);

    // The host's admin token is not a device: it has no browser, no endpoint, and an enrolment filed
    // against it could never be revoked with a device. It is the host CLI, so it arrives on the host and is
    // past the grant gate — the refusal is the route's own.
    const fromCli = await surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/push/subscriptions',
        headers: admin,
        loopback: true,
        privilegedLoopback: true,
        body: JSON.stringify(body),
      }),
    );
    // A device a session names with something the protocol refuses is treated the same way rather
    // than being persisted as an unrevocable row.
    const fromNameless = await surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/push/subscriptions',
        device: { deviceId: 'not-a-device-id', appSession: 'app-one' },
        body: JSON.stringify(body),
      }),
    );

    should([fromCli.status, fromNameless.status]).deepEqual([403, 403]);
    should(jsonBody(fromCli)).deepEqual({
      error: 'only a paired device can enrol for notifications',
      code: 'push_device_required',
    });
    should(subject.registrations).be.empty();
  });

  it('should refuse a body the wire does not describe before the subsystem is reached', async () => {
    const subject = new FakePush();

    const response = await (
      await mount(subject)
    ).dispatch(
      request({
        method: 'POST',
        path: '/v1/push/subscriptions',
        device: browser,
        body: JSON.stringify({ ...body, subscription: { ...body.subscription, endpoint: 'http://insecure.test/x' } }),
      }),
    );

    should(response.status).equal(400);
    should(subject.registrations).be.empty();
  });

  it('should answer a revocation with the enrolment it ended', async () => {
    const subject = new FakePush();

    const response = await (
      await mount(subject)
    ).dispatch(request({ method: 'DELETE', path: `/v1/push/subscriptions/${enrolmentId}`, device: browser }));

    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual(view(enrolmentId, 'Pixel 8'));
    should(subject.revocations).deepEqual([enrolmentId]);
  });

  it('should answer a revocation of something that was never enrolled with a 404', async () => {
    const subject = new FakePush();
    const surface = await mount(subject);

    const unknown = await surface.dispatch(
      request({
        method: 'DELETE',
        path: '/v1/push/subscriptions/push-99999999-9999-4999-8999-999999999999',
        device: browser,
      }),
    );
    // An id that is not even shaped like one is refused without the subsystem being asked, so a path
    // segment can never reach a store as a lookup key.
    const malformed = await surface.dispatch(
      request({ method: 'DELETE', path: '/v1/push/subscriptions/nonsense', device: browser }),
    );

    should([unknown.status, malformed.status]).deepEqual([404, 404]);
    should(jsonBody(malformed)).deepEqual({ error: 'no push enrolment with that id', code: 'push_not_found' });
    // Neither reached the subsystem's revoke: an unknown id is answered from the ownership lookup.
    should(subject.revocations).be.empty();
  });

  it('should decode a path segment before matching an enrolment id', async () => {
    const subject = new FakePush();

    const response = await (
      await mount(subject)
    ).dispatch(
      request({
        method: 'DELETE',
        path: `/v1/push/subscriptions/${encodeURIComponent(enrolmentId)}`,
        device: browser,
      }),
    );

    should(response.status).equal(200);
  });

  it('should restate each domain refusal as the answer a client can act on', async () => {
    const damaged = await mount(new FakePush([], new PushError('corrupt_store', 'the push document is damaged')));
    const rejected = await mount(new FakePush([], new PushError('invalid', 'the push service discarded it')));

    const list = await damaged.dispatch(request({ method: 'GET', path: '/v1/push/subscriptions', device: browser }));
    const enrol = await rejected.dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', device: browser, body: JSON.stringify(body) }),
    );
    const revoke = await damaged.dispatch(
      request({ method: 'DELETE', path: `/v1/push/subscriptions/${enrolmentId}`, device: browser }),
    );

    // Damaged is recoverable once somebody repairs the document, so it is a 503 and says so; a
    // subscription the push service has thrown away is the caller's problem to re-create, so 400.
    should(list.status).equal(503);
    should(jsonBody(list)).deepEqual({ error: 'the push document is damaged', code: 'push_corrupt_store' });
    should(enrol.status).equal(400);
    should(jsonBody(enrol)).deepEqual({ error: 'the push service discarded it', code: 'push_invalid' });
    should(revoke.status).equal(503);
  });

  it('should let a defect through as a defect rather than dressing it up as a refusal', async () => {
    class Broken extends FakePush {
      override async listFor(): Promise<readonly PushDeviceView[]> {
        throw new Error('/home/operator/.fy/state/push.json vanished mid-read');
      }
    }

    const response = await (
      await mount(new Broken())
    ).dispatch(request({ method: 'GET', path: '/v1/push/subscriptions', device: browser }));

    should(response.status).equal(500);
  });

  it('should refuse every route to a warden, which has no business knowing who gets notified', async () => {
    const surface = await mount(new FakePush());

    const key = await surface.dispatch(request({ method: 'GET', path: '/v1/push/vapid', headers: warden }));
    const list = await surface.dispatch(request({ method: 'GET', path: '/v1/push/subscriptions', headers: warden }));

    should([key.status, list.status]).deepEqual([403, 403]);
  });

  it('should refuse an unauthenticated caller on every route', async () => {
    const surface = await mount(new FakePush());

    const key = await surface.dispatch(request({ method: 'GET', path: '/v1/push/vapid' }));
    const enrol = await surface.dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', body: JSON.stringify(body) }),
    );

    should([key.status, enrol.status]).deepEqual([401, 401]);
  });

  it('should let a DEFAULT device enrol itself with no step-up, even with device management switched off', async () => {
    // B5: self-enrolment grants nothing — it lets this daemon reach the device that asked — so it needs
    // no `pairing.use` and no passkey. A least-privilege device (`fleet.use` only) still gets alerts.
    // Arrange
    deviceGrants = LIMITED_DEVICE_GRANTS;
    const subject = new FakePush();
    const surface = await mount(subject, false);
    const unconfirmed = { deviceId, appSession: 'app-without-step-up' } as const;

    // Act
    const key = await surface.dispatch(request({ method: 'GET', path: '/v1/push/vapid', device: unconfirmed }));
    const enrol = await surface.dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', device: unconfirmed, body: JSON.stringify(body) }),
    );
    const own = await surface.dispatch(request({ method: 'GET', path: '/v1/push/subscriptions', device: unconfirmed }));
    const unenrol = await surface.dispatch(
      request({ method: 'DELETE', path: `/v1/push/subscriptions/${enrolmentId}`, device: unconfirmed }),
    );

    // Assert
    should([key.status, enrol.status, own.status, unenrol.status]).deepEqual([200, 201, 200, 200]);
    should(subject.registrations.map(([owner]) => owner)).deepEqual([deviceId]);
  });

  it('should show a device that may not manage devices only its OWN enrolments, and refuse it another device’s', async () => {
    // Arrange
    deviceGrants = LIMITED_DEVICE_GRANTS;
    const otherEnrolment = 'push-22222222-2222-4222-8222-222222222222';
    const subject = new FakePush(
      [view(enrolmentId, 'Pixel 8'), view(otherEnrolment, 'iPad')],
      undefined,
      new Map([[otherEnrolment, otherDeviceId]]),
    );
    const surface = await mount(subject);

    // Act
    const listing = await surface.dispatch(request({ method: 'GET', path: '/v1/push/subscriptions', device: browser }));
    const theirs = await surface.dispatch(
      request({ method: 'DELETE', path: `/v1/push/subscriptions/${otherEnrolment}`, device: browser }),
    );

    // Assert
    should(jsonBody(listing)).deepEqual({ devices: [view(enrolmentId, 'Pixel 8')] });
    should(theirs.status).equal(403);
    should(jsonBody(theirs).code).equal('grant_device_not_granted');
    should(subject.revocations).be.empty();
  });

  it('should let a device that may manage devices see and revoke every enrolment, and the host always', async () => {
    // Arrange
    const otherEnrolment = 'push-22222222-2222-4222-8222-222222222222';
    const fresh = () =>
      new FakePush(
        [view(enrolmentId, 'Pixel 8'), view(otherEnrolment, 'iPad')],
        undefined,
        new Map([[otherEnrolment, otherDeviceId]]),
      );
    deviceGrants = { ...LIMITED_DEVICE_GRANTS, pairing: { use: true, configure: false } };
    const manager = fresh();
    const managing = await mount(manager);
    const host = fresh();
    const atHost = await mount(host, false);

    // Act
    const managerList = await managing.dispatch(
      request({ method: 'GET', path: '/v1/push/subscriptions', device: browser }),
    );
    const managerRevoke = await managing.dispatch(
      request({ method: 'DELETE', path: `/v1/push/subscriptions/${otherEnrolment}`, device: browser }),
    );
    const hostRevoke = await atHost.dispatch(
      request({
        method: 'DELETE',
        path: `/v1/push/subscriptions/${otherEnrolment}`,
        headers: admin,
        loopback: true,
      }),
    );
    deviceGrants = LIMITED_DEVICE_GRANTS;

    // Assert
    should((jsonBody(managerList) as { devices: unknown[] }).devices).have.length(2);
    should([managerRevoke.status, hostRevoke.status]).deepEqual([200, 200]);
    should(manager.revocations).deepEqual([otherEnrolment]);
    should(host.revocations).deepEqual([otherEnrolment]);
  });

  it('should refuse the full list to a remote caller that is neither a device nor a manager', async () => {
    // A remote admin token is a governed caller with no device, so it has no "own" list to fall back to.
    const surface = await mount(new FakePush(), false);

    const response = await surface.dispatch(
      request({ method: 'GET', path: '/v1/push/subscriptions', headers: admin, loopback: false }),
    );

    should(response.status).equal(403);
    should(jsonBody(response).code).equal('grant_not_granted');
  });
});

describe('push routes refusing a cross-device act with nothing to explain', () => {
  it('should still say why in its own words when the guard has no sentence for the refusal', async () => {
    // Arrange — the boundary's guard lets the caller through; the routes' own guard knows nothing.
    const grants = grantSubsystem({ grants: DEFAULT_CAPABILITY_GRANTS });
    await grants.refresh();
    const surface = new ApiDispatcher(
      new ApiRouter(pushRoutes(new FakePush(), NO_GOVERNED_ROUTES_GUARD)),
      credentials,
      grants,
      undefined,
      { held: () => true },
    );

    // Act
    const response = await surface.dispatch(
      request({ method: 'GET', path: '/v1/push/subscriptions', headers: admin, loopback: false }),
    );

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response)).deepEqual({
      error: 'only a device that may manage devices can change another device’s notifications',
      code: 'grant_undetermined',
    });
  });
});
