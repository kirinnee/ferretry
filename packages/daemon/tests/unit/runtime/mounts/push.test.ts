import { describe, it } from 'bun:test';
import type { PushDeviceView, RegisterPushDeviceRequest } from '@ferretry/protocol';
import should from 'should';
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
  prefs: { events: { attention: true, question: true, failed: true, completed: true }, interactiveOnly: false },
});

const body: RegisterPushDeviceRequest = {
  deviceName: 'Pixel 8',
  subscription: {
    endpoint: 'https://push.example.test/send/one',
    expirationTime: null,
    keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 4).toString('base64url') },
  },
  prefs: { events: { attention: true, question: true, failed: true, completed: true }, interactiveOnly: false },
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
  ) {}

  async publicKey(): Promise<string> {
    if (this.refusal !== undefined) throw this.refusal;
    return Buffer.alloc(65, 4).toString('base64url');
  }

  async list(): Promise<readonly PushDeviceView[]> {
    if (this.refusal !== undefined) throw this.refusal;
    return this.enrolled;
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
    identify: (token: string) =>
      token === 'device-secret' ? deviceId : token === 'nameless-secret' ? 'not-a-device-id' : undefined,
  },
};

const admin = { authorization: 'Bearer admin-secret' };
const browser = { authorization: 'Bearer device-secret' };
const warden = { authorization: 'Bearer warden-secret' };

/**
 * The mount over the REAL grant subsystem.
 *
 * Real rather than a stub guard, because the property under test is that these routes are governed by
 * the same object the operator's document feeds. `pairing` is permissive by default, so `allow: false`
 * is how a fixture states that the operator switched device management off for remote callers.
 */
async function mount(subject: PushSubscriptionSubsystem, allow = true) {
  const grants = grantSubsystem({
    grants: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: allow, configure: allow } },
  });
  await grants.refresh();
  return new ApiDispatcher(new ApiRouter(pushRoutes(subject)), credentials, grants);
}

describe('push routes', () => {
  it('should answer a paired browser with the application-server key, cacheable because it is public', async () => {
    const subject = new FakePush();

    const response = await (
      await mount(subject)
    ).dispatch(request({ method: 'GET', path: '/v1/push/vapid', headers: browser }));

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
    ).dispatch(request({ method: 'GET', path: '/v1/push/subscriptions', headers: browser }));

    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).deepEqual({ devices: [view(enrolmentId, 'Pixel 8')] });
    should(response.body).not.match(/push\.example\.test/u);
  });

  it('should file an enrolment against the CALLER, with no way for a body to claim otherwise', async () => {
    const subject = new FakePush();
    const surface = await mount(subject);

    const enrolled = await surface.dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', headers: browser, body: JSON.stringify(body) }),
    );
    // The request shape is strict, so a body that tries to name a different owner is not merely
    // ignored — it is refused. There is nowhere on this wire to claim a device.
    const claiming = await surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/push/subscriptions',
        headers: browser,
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
    // against it could never be revoked with a device.
    const fromCli = await surface.dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', headers: admin, body: JSON.stringify(body) }),
    );
    // A device the registry names with something the protocol refuses is treated the same way rather
    // than being persisted as an unrevocable row.
    const fromNameless = await surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/push/subscriptions',
        headers: { authorization: 'Bearer nameless-secret' },
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
        headers: browser,
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
    ).dispatch(request({ method: 'DELETE', path: `/v1/push/subscriptions/${enrolmentId}`, headers: browser }));

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
        headers: browser,
      }),
    );
    // An id that is not even shaped like one is refused without the subsystem being asked, so a path
    // segment can never reach a store as a lookup key.
    const malformed = await surface.dispatch(
      request({ method: 'DELETE', path: '/v1/push/subscriptions/nonsense', headers: browser }),
    );

    should([unknown.status, malformed.status]).deepEqual([404, 404]);
    should(jsonBody(malformed)).deepEqual({ error: 'no push enrolment with that id', code: 'push_not_found' });
    should(subject.revocations).have.length(1);
  });

  it('should decode a path segment before matching an enrolment id', async () => {
    const subject = new FakePush();

    const response = await (
      await mount(subject)
    ).dispatch(
      request({
        method: 'DELETE',
        path: `/v1/push/subscriptions/${encodeURIComponent(enrolmentId)}`,
        headers: browser,
      }),
    );

    should(response.status).equal(200);
  });

  it('should restate each domain refusal as the answer a client can act on', async () => {
    const damaged = await mount(new FakePush([], new PushError('corrupt_store', 'the push document is damaged')));
    const rejected = await mount(new FakePush([], new PushError('invalid', 'the push service discarded it')));

    const list = await damaged.dispatch(request({ method: 'GET', path: '/v1/push/subscriptions', headers: browser }));
    const enrol = await rejected.dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', headers: browser, body: JSON.stringify(body) }),
    );
    const revoke = await damaged.dispatch(
      request({ method: 'DELETE', path: `/v1/push/subscriptions/${enrolmentId}`, headers: browser }),
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
      override async list(): Promise<readonly PushDeviceView[]> {
        throw new Error('/home/operator/.fy/state/push.json vanished mid-read');
      }
    }

    const response = await (
      await mount(new Broken())
    ).dispatch(request({ method: 'GET', path: '/v1/push/subscriptions', headers: browser }));

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

  it('should honour an operator who switched device management off for callers who are not on the host', async () => {
    const subject = new FakePush();
    const surface = await mount(subject, false);

    const remote = await surface.dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', headers: browser, body: JSON.stringify(body) }),
    );
    // Loopback is ungoverned: somebody at the machine already has the machine, and a grant only ever
    // governs a caller who is not standing on this host.
    const local = await surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/push/subscriptions',
        headers: browser,
        loopback: true,
        body: JSON.stringify(body),
      }),
    );

    should(remote.status).equal(403);
    should(jsonBody(remote).code).match(/^grant_/u);
    should(local.status).equal(201);
  });
});
