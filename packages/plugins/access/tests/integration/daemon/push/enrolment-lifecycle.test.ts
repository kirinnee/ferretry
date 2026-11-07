import { MemoryStateFolder } from '../../../support/daemon/state-folder.ts';
import { describe, it } from 'bun:test';

import should from 'should';
import { DevicesFile, PushFile, PushKeysFile } from '../../../../contract/index.ts';
import { NodePairingCryptography, StatePairingRepository } from '../../../../daemon/adapters/pairing/index.ts';
import { StatePushRepository, StateVapidKeys, WebPushFetchTransport } from '../../../../daemon/adapters/push/index.ts';
import {
  type CapabilityGuard,
  DEFAULT_CAPABILITY_GRANTS,
  DeviceGrantService,
  decideCapability,
  describeGrantRefusal,
  type GrantEvaluation,
  isGovernedCaller,
} from '../../../../daemon/lib/grants/index.ts';
import { PairingDeviceRegistry, PairingService } from '../../../../daemon/lib/pairing/index.ts';
import { PairedPushDevices, PushService } from '../../../../daemon/lib/push/index.ts';
import { pairingRoutes } from '../../../../daemon/lib/routes/pairing.ts';
import { pushRoutes } from '../../../../daemon/lib/routes/push.ts';
import {
  type BrowserPushSubscription,
  type CapabilityGrants,
  type CapabilityPresentation,
  PushDeviceListResponseSchema,
  PushDeviceViewSchema,
  VapidPublicKeyResponseSchema,
} from '../../../../daemon/lib/wire.ts';
import { type CallOverrides, respond } from '../../../support/daemon/call.ts';

/**
 * PAIRING A DEVICE SETS IT UP FOR NOTIFICATIONS, AND REVOKING IT TAKES THEM AWAY.
 *
 * The whole point of this file is that nothing in it is a fixture agreeing with itself. The routes, the grant
 * decision, the grant service, the pairing state machine, both durable documents (through the kernel's state rules)
 * and the real Web Push encryption are all the production ones; the only substitutions are the push service on the
 * far side of the network — which is a third party this suite may not call — the clock, and Gate's admission, which
 * in 5.0 runs before a handler and stamps the standing a call carries (`support/daemon/call.ts`).
 *
 * That is deliberate, because the defect this surface exists to close was exactly two halves that each
 * passed against their own stub: the browser asked a route for a VAPID key and the daemon served no push
 * routes at all, and every test on both sides was green.
 */

const AT = '2026-08-05T09:00:00.000Z';
const DAEMON_ID = `fy_daemon_${'w'.repeat(43)}`;
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

/** The kernel clock's `after`, as a real timer: a delivery arms its timeout with it. */
const timer = (ms: number, fn: () => void): (() => void) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/** The push service's own record of what reached it, and what it chooses to answer. */
class FakePushService {
  readonly received: Array<{ readonly endpoint: string; readonly body: Uint8Array }> = [];
  status = 201;

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    this.received.push({ endpoint: url, body: init.body as Uint8Array });
    return new Response('', { status: this.status });
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

/** The grants decision the push routes render (the runtime's `gateGuard`), over a fixed daemon-wide document. */
function guardOver(grants: CapabilityGrants): CapabilityGuard {
  const evaluate = (presentation: CapabilityPresentation): GrantEvaluation => ({
    grants,
    governed: isGovernedCaller({ loopback: presentation.local }),
    hostLocal: presentation.local,
    stepUp: presentation.stepUp,
    ...(isGovernedCaller({ loopback: presentation.local }) && presentation.deviceGrants !== undefined
      ? { device: presentation.deviceGrants }
      : {}),
  });
  return {
    decide: (demand, presentation) => decideCapability(demand, evaluate(presentation)),
    governance: presentation => {
      const evaluation = evaluate(presentation);
      return { governed: evaluation.governed, decide: demand => decideCapability(demand, evaluation) };
    },
    explain: (demand, refusal) => describeGrantRefusal(demand, refusal, 'fy'),
  };
}

const noAudit = {
  record: async () => undefined,
  recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
};

/** The whole daemon-side surface these two subjects share, over one Access state folder. */
async function daemon() {
  const folder = new MemoryStateFolder();
  const state = folder.port([DevicesFile, PushFile, PushKeysFile]);

  /**
   * WHETHER THE PAIRED BROWSER HAS CONFIRMED WITH ITS PASSKEY, and the one switch this file turns.
   *
   * Self-enrolment is held behind a step-up for a caller who did not arrive on the host — which is every
   * browser below. So the journeys run CONFIRMED (the state a person is in after tapping the passkey
   * prompt) and one case flips it to prove the same route refuses an unconfirmed device. The witness
   * is the presentation Gate stamps; `StepUpService`'s own ceremony is proved where it lives.
   */
  const stepUp = { confirmed: true };
  const pairingRepository = new StatePairingRepository(state);
  const opened = await pairingRepository.open({ daemonId: DAEMON_ID, daemonName: 'workstation' });
  const credentials = new PairingDeviceRegistry(opened.daemonId, opened.devices);

  const pushService = new FakePushService();
  const vapidKeys = new StateVapidKeys(state);
  const push = new PushService({
    store: new StatePushRepository(state),
    keys: vapidKeys,
    transport: new WebPushFetchTransport(vapidKeys, pushService.fetch, () => Date.parse(AT), timer),
    devices: new PairedPushDevices(pairingRepository),
    clock: { now: () => AT },
    ids: { next: () => crypto.randomUUID() },
  });
  const pairing = new PairingService({
    daemonId: opened.daemonId,
    daemonName: opened.daemonName,
    advertisement: { kind: 'address', url: 'https://workstation.example.test', origin: 'operator' },
    carriers: { current: () => [{ kind: 'direct', url: 'https://workstation.example.test' }] },
    clock: { now: () => Date.parse(AT) },
    cryptography: new NodePairingCryptography(),
    devices: pairingRepository,
    credentials,
    deviceState: [push],
  });
  const deviceGrants = new DeviceGrantService({
    devices: pairing,
    daemonWide: () => DEFAULT_CAPABILITY_GRANTS,
    audit: noAudit,
    clock: { nowMs: () => Date.parse(AT) },
    clientName: 'fy',
  });

  const routes = [...pairingRoutes(pairing, deviceGrants), ...pushRoutes(push, guardOver(DEFAULT_CAPABILITY_GRANTS))];
  /** One call as Gate admits it: a device carries its own record's grants and whether it has confirmed. */
  const dispatch = async (key: string, overrides: CallOverrides = {}) =>
    await respond(
      routes,
      key,
      overrides.device === undefined
        ? overrides
        : {
            deviceGrants: credentials.get(overrides.device.deviceId)?.grants ?? null,
            presentation: { stepUp: stepUp.confirmed },
            ...overrides,
          },
    );
  return { folder, dispatch, pairing, pushService, stepUp };
}

/**
 * Pairs one browser through the real exchange and answers with the device it became.
 *
 * Redemption happens inside a session, so it is driven through the pairing state machine's one
 * session entry rather than a route; what the device then presents is the principal its session
 * proved, stamped on the request the way the kernel stamps it.
 */
async function pair(world: Awaited<ReturnType<typeof daemon>>, deviceName: string) {
  const minted = await world.dispatch('POST /v1/pair/code', { host: true });
  should(minted.status).equal(201);
  const code = (JSON.parse(minted.body) as { code: string }).code;
  const redeemed = await world.pairing.redeemInSession(
    { code, deviceName, deviceKey: DEVICE_KEY, prove: async () => true },
    { kind: 'direct', rateLimitKey: '198.51.100.7' },
  );
  should(redeemed.kind).equal('paired');
  const devices = await world.dispatch('GET /v1/pair/devices', { host: true });
  const listed = JSON.parse(devices.body) as { devices: readonly { id: string; name: string }[] };
  const deviceId = listed.devices.find(device => device.name === deviceName)?.id;
  should(deviceId).be.a.String();
  return { device: { deviceId: deviceId ?? '', appSession: 'app-one' }, deviceId: deviceId ?? '' };
}

describe('push enrolment over the real route surface', () => {
  it('should carry one browser from pairing to a live enrolment and back to nothing', async () => {
    const world = await daemon();
    const browser = await pair(world, 'Pixel 8');

    // ── the key the browser subscribes with ─────────────────────────────────────────────────────
    const key = await world.dispatch('GET /v1/push/vapid', { device: browser.device });
    should(key.status).equal(200);
    const publicKey = VapidPublicKeyResponseSchema.parse(JSON.parse(key.body)).publicKey;
    // 65 bytes, uncompressed — the exact thing `pushManager.subscribe` demands. The client-side decoder
    // in the browser bundle refuses anything else, which is the agreement this assertion stands for.
    should(Buffer.from(publicKey, 'base64url')).have.length(65);

    // ── enrolment ───────────────────────────────────────────────────────────────────────────────
    const subscription = await subscribed('https://fcm.googleapis.com/send/pixel');
    const enrolled = await world.dispatch('POST /v1/push/subscriptions', {
      device: browser.device,
      body: JSON.stringify({
        deviceName: 'Pixel 8',
        subscription,
      }),
    });
    should(enrolled.status).equal(201);
    const view = PushDeviceViewSchema.parse(JSON.parse(enrolled.body));
    // The enrolment was USED, not merely stored: the push service that owns the endpoint received one
    // real encrypted confirmation before this route answered.
    should(world.pushService.received.map(sent => sent.endpoint)).deepEqual([subscription.endpoint]);
    should(world.pushService.received[0]?.body.byteLength).be.above(85);

    const listed = await world.dispatch('GET /v1/push/subscriptions', { device: browser.device });
    should(PushDeviceListResponseSchema.parse(JSON.parse(listed.body)).devices.map(device => device.id)).deepEqual([
      view.id,
    ]);
    // Nothing on this wire can be replayed to wake the device: the triple lives only in the document.
    should(listed.body).not.match(/fcm\.googleapis\.com/u);
    should(world.folder.raw(PushFile)).match(/fcm\.googleapis\.com/u);

    // ── revoking the DEVICE takes the notifications with it ─────────────────────────────────────
    const revoked = await world.dispatch('DELETE /v1/pair/devices/:deviceId', {
      host: true,
      params: { deviceId: browser.deviceId },
    });
    should(revoked.status).equal(200);

    // The grant is gone, so the browser cannot even ask any more: the device mode names no key for it and the
    // credential provider no standing, so the kernel refuses its session and Gate its calls. That is why the check
    // below is made with the host's own token rather than the device's.
    should(await world.pairing.deviceKey(browser.deviceId)).be.undefined();
    should(world.pairing.deviceGrants(browser.deviceId)).be.undefined();

    const remaining = await world.dispatch('GET /v1/push/subscriptions', { host: true });
    should(PushDeviceListResponseSchema.parse(JSON.parse(remaining.body)).devices).be.empty();
    // Gone from the DOCUMENT, not merely filtered out of an answer: a row that survived would be a
    // capability to wake a phone whose owner revoked it.
    should(world.folder.raw(PushFile)).not.match(/fcm\.googleapis\.com/u);
  });

  it('G166 should take a revoked device’s enrolments with it and leave another device’s alone', async () => {
    const world = await daemon();
    const phone = await pair(world, 'Pixel 8');
    const tablet = await pair(world, 'iPad');

    const enrol = async (
      browser: { device: { readonly deviceId: string; readonly appSession: string } },
      deviceName: string,
      endpoint: string,
    ) => {
      const response = await world.dispatch('POST /v1/push/subscriptions', {
        device: browser.device,
        body: JSON.stringify({
          deviceName,
          subscription: await subscribed(endpoint),
        }),
      });
      should(response.status).equal(201);
      return PushDeviceViewSchema.parse(JSON.parse(response.body));
    };
    const phoneEnrolment = await enrol(phone, 'Pixel 8', 'https://fcm.googleapis.com/send/pixel');
    const tabletEnrolment = await enrol(tablet, 'iPad', 'https://fcm.googleapis.com/send/ipad');

    await world.dispatch('DELETE /v1/pair/devices/:deviceId', { host: true, params: { deviceId: phone.deviceId } });

    const remaining = await world.dispatch('GET /v1/push/subscriptions', { device: tablet.device });
    should(PushDeviceListResponseSchema.parse(JSON.parse(remaining.body)).devices.map(device => device.id)).deepEqual([
      tabletEnrolment.id,
    ]);
    should(phoneEnrolment.id).not.equal(tabletEnrolment.id);
    // The phone's endpoint is gone from the document, the tablet's is not.
    should(world.folder.raw(PushFile)).not.match(/send\/pixel/u);
    should(world.folder.raw(PushFile)).match(/send\/ipad/u);
  });

  it('G166 should refuse an endpoint that is not a browser push service before anything is stored or sent', async () => {
    const world = await daemon();
    const browser = await pair(world, 'Pixel 8');

    const response = await world.dispatch('POST /v1/push/subscriptions', {
      device: browser.device,
      body: JSON.stringify({
        deviceName: 'Pixel 8',
        subscription: await subscribed('https://internal.example.test/hook'),
      }),
    });

    should(response.status).equal(400);
    should(world.pushService.received).be.empty();
    should(world.folder.raw(PushFile)).be.undefined();
  });

  it('should forget an enrolment the push service has already discarded, answering as for a live one', async () => {
    // The answer is never the confirmation's fate, or it would be a reachability oracle (review M2).
    const world = await daemon();
    const browser = await pair(world, 'Pixel 8');
    world.pushService.status = 410;

    const response = await world.dispatch('POST /v1/push/subscriptions', {
      device: browser.device,
      body: JSON.stringify({
        deviceName: 'Pixel 8',
        subscription: await subscribed('https://fcm.googleapis.com/send/dead'),
      }),
    });

    should(response.status).equal(201);
    const listed = await world.dispatch('GET /v1/push/subscriptions', { device: browser.device });
    should(PushDeviceListResponseSchema.parse(JSON.parse(listed.body)).devices).be.empty();
  });

  it('G165 should let a DEFAULT paired browser enrol ITSELF once it has confirmed, and not before', async () => {
    // Self-enrolment grants nothing, so it needs no `pairing.use`: a default device still gets alerts.
    // But it makes this host send requests to the endpoint, so a governed device confirms with its
    // passkey first (review M2).
    const world = await daemon();
    const browser = await pair(world, 'Pixel 8');
    world.stepUp.confirmed = false;
    const body = JSON.stringify({
      deviceName: 'Pixel 8',
      subscription: await subscribed('https://fcm.googleapis.com/send/unconfirmed'),
    });

    const unconfirmed = await world.dispatch('POST /v1/push/subscriptions', { device: browser.device, body });
    world.stepUp.confirmed = true;
    const enrolled = await world.dispatch('POST /v1/push/subscriptions', { device: browser.device, body });
    const listed = await world.dispatch('GET /v1/push/subscriptions', { device: browser.device });

    should(unconfirmed.status).equal(403);
    should(JSON.parse(unconfirmed.body).code).equal('grant_step_up_required');
    should(enrolled.status).equal(201);
    should(world.pushService.received).have.length(1);
    should(PushDeviceListResponseSchema.parse(JSON.parse(listed.body)).devices).have.length(1);
  });

  it('should refuse the host’s own token an enrolment, having no browser to enrol', async () => {
    const world = await daemon();

    const response = await world.dispatch('POST /v1/push/subscriptions', {
      host: true,
      body: JSON.stringify({
        deviceName: 'The machine',
        subscription: await subscribed('https://fcm.googleapis.com/send/host'),
      }),
    });

    should(response.status).equal(403);
    should(JSON.parse(response.body).code).equal('push_device_required');
  });
});
