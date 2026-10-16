import { afterAll, describe, it } from 'bun:test';
import { join } from 'node:path';
import {
  type BrowserPushSubscription,
  DAEMON_CAPABILITIES,
  PushDeviceListResponseSchema,
  PushDeviceViewSchema,
  VapidPublicKeyResponseSchema,
} from '@ferretry/protocol';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { NodePairingCryptography, StatePairingRepository } from '../../../src/adapters/pairing/index.ts';
import { StatePushRepository, StateVapidKeys, WebPushFetchTransport } from '../../../src/adapters/push/index.ts';
import { ApiDispatcher, type ApiRequest, ApiRouter, headersFrom, queryFrom } from '../../../src/lib/api/index.ts';
import {
  CapabilityGrantService,
  createFoundationPaths,
  DEFAULT_CAPABILITY_GRANTS,
  DeviceGrantService,
  PairedPushDevices,
  PairingDeviceRegistry,
  PairingService,
  PushService,
  pairingRoutes,
  pushRoutes,
  resolveStateHome,
} from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

afterAll(async () => {
  await cleanupTempDirectories();
});

/**
 * PAIRING A DEVICE SETS IT UP FOR NOTIFICATIONS, AND REVOKING IT TAKES THEM AWAY.
 *
 * The whole point of this file is that nothing in it is a fixture agreeing with itself. The dispatcher,
 * the routes, the authorization boundary, the grant service, the pairing state machine, both durable
 * documents and the real Web Push encryption are all the production ones; the only substitutions are
 * the push service on the far side of the network — which is a third party this suite may not call —
 * and the clock.
 *
 * That is deliberate, because the defect this surface exists to close was exactly two halves that each
 * passed against their own stub: the browser asked a route for a VAPID key and the daemon served no push
 * routes at all, and every test on both sides was green.
 */

const ADMIN = 'admin-secret';
const admin = { authorization: `Bearer ${ADMIN}` };
/** An Ed25519 SPKI: the fixed DER prefix and 32 key bytes. The session that proved it is not this test's subject. */
const DEVICE_KEY = Buffer.from([
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
  ...new Array(32).fill(5),
]).toString('base64url');

/** The push service's own record of what reached it, and what it chooses to answer. */
class FakePushService {
  readonly received: Array<{ readonly endpoint: string; readonly body: Uint8Array }> = [];
  status = 201;

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    this.received.push({ endpoint: url, body: init.body as Uint8Array });
    return new Response('', { status: this.status });
  };
}

function request(overrides: {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly device?: { readonly deviceId: string; readonly appSession: string };
  readonly body?: string;
  readonly loopback?: boolean;
}): ApiRequest {
  return {
    method: overrides.method,
    path: overrides.path,
    query: queryFrom([]),
    headers: headersFrom(overrides.headers ?? {}),
    clientAddress: overrides.loopback === true ? '127.0.0.1' : '198.51.100.7',
    loopback: overrides.loopback ?? false,
    ...(overrides.device === undefined ? {} : { device: overrides.device }),
    text: async () => overrides.body ?? '',
  };
}

/** A browser that really subscribed: its own P-256 pair, and the auth secret it generated. */
async function subscribed(endpoint: string): Promise<BrowserPushSubscription> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: Buffer.from(publicKey).toString('base64url'),
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    },
  };
}

/** The whole daemon-side surface these two subjects share, over one real state home. */
async function daemon(label: string) {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.state, 0o700);

  /**
   * WHETHER THE PAIRED BROWSER HAS CONFIRMED WITH ITS PASSKEY, and the one switch this file turns.
   *
   * Enrolment is governed by `pairing.use`, and the policy holds that behind a step-up for a caller
   * who did not arrive on the host — which is every browser below, since none of them sets
   * `loopback`. So the journeys run CONFIRMED (the state a person is in after tapping the passkey
   * prompt) and one case flips it to prove the same route refuses an unconfirmed device. The witness
   * is a fake of the step-up SERVICE, not of the gate: the real policy, grant service, dispatcher and
   * routes are all in play, and `StepUpService`'s own ceremony is proved where it lives.
   */
  const stepUp = {
    confirmed: true,
    held(): boolean {
      return this.confirmed;
    },
  };
  const cryptography = new NodePairingCryptography();
  const pairingRepository = new StatePairingRepository(paths, files, cryptography);
  const state = await pairingRepository.open('workstation');
  const credentials = new PairingDeviceRegistry(state.daemonId, state.devices);

  const pushService = new FakePushService();
  const vapidKeys = new StateVapidKeys(paths, files);
  const push = new PushService({
    store: new StatePushRepository(paths, files),
    keys: vapidKeys,
    transport: new WebPushFetchTransport(vapidKeys, pushService.fetch),
    devices: new PairedPushDevices(pairingRepository),
    clock: { now: () => '2026-08-05T09:00:00.000Z' },
    ids: { next: () => crypto.randomUUID() },
  });
  const pairing = new PairingService({
    daemonId: state.daemonId,
    daemonName: state.daemonName,
    advertisement: { kind: 'address', url: 'https://workstation.example.test', origin: 'operator' },
    carriers: [{ kind: 'direct', url: 'https://workstation.example.test' }],
    clock: { now: () => Date.now() },
    cryptography,
    devices: pairingRepository,
    credentials,
    deviceState: [push],
  });

  const grants = new CapabilityGrantService({
    document: {
      read: async () => DEFAULT_CAPABILITY_GRANTS,
      written: async () => DAEMON_CAPABILITIES,
      write: async () => undefined,
    },
    clock: { nowMs: () => Date.now() },
    audit: { record: async () => undefined, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
    clientName: 'fy',
  });
  await grants.refresh();
  const deviceGrants = new DeviceGrantService({
    devices: pairing,
    daemonWide: () => grants.enforced(),
    audit: { record: async () => undefined, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
    clock: { nowMs: () => Date.now() },
    clientName: 'fy',
  });

  const surface = new ApiDispatcher(
    new ApiRouter([...pairingRoutes(pairing, deviceGrants), ...pushRoutes(push, grants)]),
    {
      admin: ADMIN,
      warden: 'warden-secret',
      // The REAL registry's grants: a device paired here holds the default, `fleet.use` only.
      devices: {
        has: deviceId => credentials.get(deviceId) !== undefined,
        grants: deviceId => credentials.get(deviceId)?.grants,
      },
    },
    grants,
    undefined,
    stepUp,
  );
  return { paths, files, surface, pairing, pushService, stepUp, document: join(paths.state, 'push.json') };
}

/**
 * Pairs one browser through the real exchange and answers with the device it became.
 *
 * Redemption happens inside a session, so it is driven through the pairing state machine's one
 * session entry rather than a route; what the device then presents is the identity its session
 * proved — set on the request the way the tunnel sets it.
 */
async function pair(world: Awaited<ReturnType<typeof daemon>>, deviceName: string) {
  const minted = await world.surface.dispatch(
    request({ method: 'POST', path: '/v1/pair/code', headers: admin, loopback: true }),
  );
  should(minted.status).equal(201);
  const code = (JSON.parse(minted.body) as { code: string }).code;
  const redeemed = await world.pairing.redeemInSession(
    { code, deviceName, deviceKey: DEVICE_KEY, prove: async () => true },
    { kind: 'direct', rateLimitKey: '198.51.100.7' },
  );
  should(redeemed.kind).equal('paired');
  const devices = await world.surface.dispatch(
    request({ method: 'GET', path: '/v1/pair/devices', headers: admin, loopback: true }),
  );
  const listed = JSON.parse(devices.body) as { devices: readonly { id: string; name: string }[] };
  const deviceId = listed.devices.find(device => device.name === deviceName)?.id;
  should(deviceId).be.a.String();
  return { device: { deviceId: deviceId ?? '', appSession: 'app-one' }, deviceId: deviceId ?? '' };
}

describe('push enrolment over the real route surface', () => {
  it('should carry one browser from pairing to a live enrolment and back to nothing', async () => {
    const world = await daemon('push-lifecycle');
    const browser = await pair(world, 'Pixel 8');

    // ── the key the browser subscribes with ─────────────────────────────────────────────────────
    const key = await world.surface.dispatch(
      request({ method: 'GET', path: '/v1/push/vapid', device: browser.device }),
    );
    should(key.status).equal(200);
    const publicKey = VapidPublicKeyResponseSchema.parse(JSON.parse(key.body)).publicKey;
    // 65 bytes, uncompressed — the exact thing `pushManager.subscribe` demands. The client-side decoder
    // in the browser bundle refuses anything else, which is the agreement this assertion stands for.
    should(Buffer.from(publicKey, 'base64url')).have.length(65);

    // ── enrolment ───────────────────────────────────────────────────────────────────────────────
    const subscription = await subscribed('https://fcm.googleapis.com/send/pixel');
    const enrolled = await world.surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/push/subscriptions',
        device: browser.device,
        body: JSON.stringify({
          deviceName: 'Pixel 8',
          subscription,
        }),
      }),
    );
    should(enrolled.status).equal(201);
    const view = PushDeviceViewSchema.parse(JSON.parse(enrolled.body));
    // The enrolment was USED, not merely stored: the push service that owns the endpoint received one
    // real encrypted confirmation before this route answered.
    should(world.pushService.received.map(sent => sent.endpoint)).deepEqual([subscription.endpoint]);
    should(world.pushService.received[0]?.body.byteLength).be.above(85);

    const listed = await world.surface.dispatch(
      request({ method: 'GET', path: '/v1/push/subscriptions', device: browser.device }),
    );
    should(PushDeviceListResponseSchema.parse(JSON.parse(listed.body)).devices.map(device => device.id)).deepEqual([
      view.id,
    ]);
    // Nothing on this wire can be replayed to wake the device: the triple lives only in the document.
    should(listed.body).not.match(/fcm\.googleapis\.com/u);
    should(await world.files.readText(world.document)).match(/fcm\.googleapis\.com/u);

    // ── revoking the DEVICE takes the notifications with it ─────────────────────────────────────
    const revoked = await world.surface.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${browser.deviceId}`, headers: admin, loopback: true }),
    );
    should(revoked.status).equal(200);

    // The credential is gone, so the browser cannot even ask any more — which is why the check below is
    // made with the host's own token rather than the device's.
    const afterRevoke = await world.surface.dispatch(
      request({ method: 'GET', path: '/v1/push/subscriptions', device: browser.device }),
    );
    should(afterRevoke.status).equal(401);

    const remaining = await world.surface.dispatch(
      request({ method: 'GET', path: '/v1/push/subscriptions', headers: admin, loopback: true }),
    );
    should(PushDeviceListResponseSchema.parse(JSON.parse(remaining.body)).devices).be.empty();
    // Gone from the DOCUMENT, not merely filtered out of an answer: a row that survived would be a
    // capability to wake a phone whose owner revoked it.
    should(await world.files.readText(world.document)).not.match(/fcm\.googleapis\.com/u);
  });

  it('should leave one device’s enrolment alone when another is revoked', async () => {
    const world = await daemon('push-two-devices');
    const phone = await pair(world, 'Pixel 8');
    const tablet = await pair(world, 'iPad');

    const enrol = async (
      browser: { device: { readonly deviceId: string; readonly appSession: string } },
      deviceName: string,
      endpoint: string,
    ) => {
      const response = await world.surface.dispatch(
        request({
          method: 'POST',
          path: '/v1/push/subscriptions',
          device: browser.device,
          body: JSON.stringify({
            deviceName,
            subscription: await subscribed(endpoint),
          }),
        }),
      );
      should(response.status).equal(201);
      return PushDeviceViewSchema.parse(JSON.parse(response.body));
    };
    const phoneEnrolment = await enrol(phone, 'Pixel 8', 'https://fcm.googleapis.com/send/pixel');
    const tabletEnrolment = await enrol(tablet, 'iPad', 'https://fcm.googleapis.com/send/ipad');

    await world.surface.dispatch(
      request({ method: 'DELETE', path: `/v1/pair/devices/${phone.deviceId}`, headers: admin, loopback: true }),
    );

    const remaining = await world.surface.dispatch(
      request({ method: 'GET', path: '/v1/push/subscriptions', device: tablet.device }),
    );
    should(PushDeviceListResponseSchema.parse(JSON.parse(remaining.body)).devices.map(device => device.id)).deepEqual([
      tabletEnrolment.id,
    ]);
    should(phoneEnrolment.id).not.equal(tabletEnrolment.id);
  });

  it('should forget an enrolment the push service has already discarded, answering as for a live one', async () => {
    // The answer is never the confirmation's fate, or it would be a reachability oracle (review M2).
    const world = await daemon('push-gone');
    const browser = await pair(world, 'Pixel 8');
    world.pushService.status = 410;

    const response = await world.surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/push/subscriptions',
        device: browser.device,
        body: JSON.stringify({
          deviceName: 'Pixel 8',
          subscription: await subscribed('https://fcm.googleapis.com/send/dead'),
        }),
      }),
    );

    should(response.status).equal(201);
    const listed = await world.surface.dispatch(
      request({ method: 'GET', path: '/v1/push/subscriptions', device: browser.device }),
    );
    should(PushDeviceListResponseSchema.parse(JSON.parse(listed.body)).devices).be.empty();
  });

  it('should let a DEFAULT paired browser enrol ITSELF once it has confirmed, and not before', async () => {
    // Self-enrolment grants nothing, so it needs no `pairing.use`: a default device still gets alerts.
    // But it makes this host send requests to the endpoint, so a governed device confirms with its
    // passkey first (review M2).
    const world = await daemon('push-unconfirmed');
    const browser = await pair(world, 'Pixel 8');
    world.stepUp.confirmed = false;
    const body = JSON.stringify({
      deviceName: 'Pixel 8',
      subscription: await subscribed('https://fcm.googleapis.com/send/unconfirmed'),
    });

    const unconfirmed = await world.surface.dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', device: browser.device, body }),
    );
    world.stepUp.confirmed = true;
    const enrolled = await world.surface.dispatch(
      request({ method: 'POST', path: '/v1/push/subscriptions', device: browser.device, body }),
    );
    const listed = await world.surface.dispatch(
      request({ method: 'GET', path: '/v1/push/subscriptions', device: browser.device }),
    );

    should(unconfirmed.status).equal(403);
    should(JSON.parse(unconfirmed.body).code).equal('grant_step_up_required');
    should(enrolled.status).equal(201);
    should(world.pushService.received).have.length(1);
    should(PushDeviceListResponseSchema.parse(JSON.parse(listed.body)).devices).have.length(1);
  });

  it('should refuse the host’s own token an enrolment, having no browser to enrol', async () => {
    const world = await daemon('push-admin');

    const response = await world.surface.dispatch(
      request({
        method: 'POST',
        path: '/v1/push/subscriptions',
        headers: admin,
        loopback: true,
        body: JSON.stringify({
          deviceName: 'The machine',
          subscription: await subscribed('https://fcm.googleapis.com/send/host'),
        }),
      }),
    );

    should(response.status).equal(403);
    should(JSON.parse(response.body).code).equal('push_device_required');
  });
});
