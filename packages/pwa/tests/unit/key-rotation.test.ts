/**
 * Device-key rotation, browser half (`docs/design/zero-trust.md` B6).
 *
 * Two layers, both against real WebCrypto and a scripted daemon whose accepted keys change when it
 * swaps: `KeyRotation` on its own (when is a step-up amended, what settles the pending key), and the
 * carrier router carrying it (the proof rides the session it signed, and a refused old key falls back
 * to the pending one exactly once).
 */

import { describe, it } from 'bun:test';
import { DeviceKeyRotationSchema } from '@ferretry/protocol';
import { toBase64Url } from '@ferretry/relay';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { KeyRotation, type RotatingSession } from '../../src/lib/key-rotation.ts';
import { DaemonCarrierRouter, DeviceNotAcceptedError } from '../../src/lib/relay-carrier.ts';
import { MemoryDeviceKeyStore } from '../support/device-keys.ts';
import { newDaemonIdentity, relayCrypto, ScriptedSocket } from '../support/relay.ts';
import { type RotatingRequest, rotatingDial } from '../support/rotating-daemon.ts';

const URL_BASE = 'https://studio.example';
const DEVICE_ID = 'fy_device_id_rotationTestDevice0000001';
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-11-01T00:00:00.000Z';
const ASSERTION = JSON.stringify({ credentialId: 'c', clientDataJSON: 'd', authenticatorData: 'a', signature: 's' });
const STEP_UP = `${URL_BASE}/v1/step-up`;
const UNLOCK = `${URL_BASE}/v1/unlock`;
const POST = { method: 'POST', body: ASSERTION } as const;

const keyPair = async () => {
  const minted = await relayCrypto.generateDeviceKey();
  return { privateKey: minted.privateKey, publicKey: toBase64Url(minted.publicKeySpki) };
};

const newRotation = (store: MemoryDeviceKeyStore, now = NOW) =>
  new KeyRotation({ store, crypto: relayCrypto, now: () => now });

/** A session that only reports what `rotateBy` it was given, and records what it was asked to sign. */
const fakeSession = (rotateBy: string | undefined): RotatingSession & { readonly signed: string[] } => {
  const signed: string[] = [];
  return {
    signed,
    rotateBy: () => rotateBy,
    signRotation: async (deviceId, _key, newPublicKey) => {
      signed.push(`${deviceId}:${newPublicKey}`);
      return { deviceKey: newPublicKey, proof: 'p'.repeat(86) };
    },
  };
};

const daemon = { daemonId: 'fy_daemon_rotation', deviceId: DEVICE_ID };

describe('amending a step-up with a rotation', () => {
  it('should add a rotation, saved as pending BEFORE it is signed, once rotateBy has passed', async () => {
    const store = new MemoryDeviceKeyStore();
    const session = fakeSession(PAST);
    const order: string[] = [];
    const savePending = store.savePending.bind(store);
    store.savePending = async (...args) => {
      order.push('saved');
      await savePending(...args);
    };
    const sign = session.signRotation.bind(session);
    session.signRotation = async (...args) => {
      order.push('signed');
      return await sign(...args);
    };

    const amended = await newRotation(store).amend(session, daemon, STEP_UP, POST);

    should(amended.rotated).be.true();
    const body = JSON.parse(String(amended.init.body)) as Record<string, unknown>;
    should(body).have.property('credentialId', 'c');
    should(DeviceKeyRotationSchema.safeParse(body.rotation).success).be.true();
    should(order).eql(['saved', 'signed']);
    const pending = store.pending.get(daemon.daemonId);
    should(pending?.extractable).be.false();
    should(session.signed).have.length(1);
    should(session.signed[0]).startWith(`${DEVICE_ID}:`);
  });

  it('should leave the request alone when rotateBy is in the future, absent or unreadable', async () => {
    for (const rotateBy of [FUTURE, undefined, 'not an instant']) {
      const store = new MemoryDeviceKeyStore();
      const amended = await newRotation(store).amend(fakeSession(rotateBy), daemon, STEP_UP, POST);
      should(amended).eql({ init: POST, rotated: false });
      should(store.pending.size).equal(0);
    }
  });

  it('should add the same rotation to an unlock, the first ceremony an overdue device meets', async () => {
    const store = new MemoryDeviceKeyStore();
    const session = fakeSession(PAST);

    const amended = await newRotation(store).amend(session, daemon, UNLOCK, POST);

    should(amended.rotated).be.true();
    const body = JSON.parse(String(amended.init.body)) as Record<string, unknown>;
    should(DeviceKeyRotationSchema.safeParse(body.rotation).success).be.true();
    should(store.pending.size).equal(1);
    should(session.signed).have.length(1);
  });

  it('should treat the instant itself as due', async () => {
    const store = new MemoryDeviceKeyStore();
    const amended = await newRotation(store, Date.parse(PAST)).amend(fakeSession(PAST), daemon, STEP_UP, POST);
    should(amended.rotated).be.true();
  });

  it('should leave every other route, method and body alone, however overdue', async () => {
    const store = new MemoryDeviceKeyStore();
    const session = fakeSession(PAST);
    const rotation = newRotation(store);
    const cases: [string, RequestInit][] = [
      [`${URL_BASE}/v1/step-up/options`, POST],
      [`${URL_BASE}/v1/unlock/options`, POST],
      [`${URL_BASE}/v1/passkeys`, POST],
      [STEP_UP, { method: 'GET' }],
      [STEP_UP, {}],
      [STEP_UP, { method: 'POST' }],
      [STEP_UP, { method: 'POST', body: '{not json' }],
      [STEP_UP, { method: 'POST', body: '[1]' }],
      [STEP_UP, { method: 'POST', body: 'null' }],
      [STEP_UP, { method: 'POST', body: '"text"' }],
    ];
    for (const [url, init] of cases)
      should(await rotation.amend(session, daemon, url, init)).eql({ init, rotated: false });
    should(store.pending.size).equal(0);
    should(session.signed).eql([]);
  });
});

const granted = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('settling the pending key from the daemon’s answer', () => {
  const stored = async () => {
    const store = new MemoryDeviceKeyStore();
    const current = await keyPair();
    const pending = await keyPair();
    await store.save(daemon.daemonId, current.privateKey);
    await store.savePending(daemon.daemonId, pending.privateKey);
    return { store, current, pending };
  };

  it('should promote the pending key on keyRotated', async () => {
    const { store, pending } = await stored();
    await newRotation(store).settle(daemon.daemonId, granted({ expiresAt: FUTURE, keyRotated: true }));
    should(store.keys.get(daemon.daemonId)).equal(pending.privateKey);
    should(store.pending.size).equal(0);
  });

  it('should promote the pending key on an unlock answer that says keyRotated', async () => {
    const { store, pending } = await stored();
    await newRotation(store).settle(daemon.daemonId, granted({ unlockedUntil: FUTURE, keyRotated: true }));
    should(store.keys.get(daemon.daemonId)).equal(pending.privateKey);
    should(store.pending.size).equal(0);
  });

  it('should discard it when the unlock was granted without a swap', async () => {
    const { store, current } = await stored();
    await newRotation(store).settle(daemon.daemonId, granted({ unlockedUntil: FUTURE }));
    should(store.keys.get(daemon.daemonId)).equal(current.privateKey);
    should(store.pending.size).equal(0);
  });

  it('should discard it when the step-up was granted without a swap', async () => {
    const { store, current } = await stored();
    await newRotation(store).settle(daemon.daemonId, granted({ expiresAt: FUTURE }));
    should(store.keys.get(daemon.daemonId)).equal(current.privateKey);
    should(store.pending.size).equal(0);
  });

  it('should discard it on a refusal, and on a body it cannot read', async () => {
    for (const response of [
      granted({ code: 'step_up_rotation_required' }, 403),
      new Response('not json', { status: 200 }),
      granted({ expiresAt: FUTURE, keyRotated: false }),
    ]) {
      const { store, current } = await stored();
      await newRotation(store).settle(daemon.daemonId, response);
      should(store.keys.get(daemon.daemonId)).equal(current.privateKey);
      should(store.pending.size).equal(0);
    }
  });

  it('should hand the pending key back as a handle, and nothing when none is in flight', async () => {
    const { store } = await stored();
    const rotation = newRotation(store);
    should(await rotation.pending(daemon.daemonId)).not.be.undefined();
    await rotation.discard(daemon.daemonId);
    should(await rotation.pending(daemon.daemonId)).be.undefined();
    await rotation.promote(daemon.daemonId);
    should(store.keys.size).equal(1);
  });
});

/* ---------- through the carrier router ------------------------------------ */

interface Rig {
  readonly router: DaemonCarrierRouter;
  readonly daemonId: string;
  /** Dials after this many sockets exist are refused as an unreachable carrier would be. */
  readonly carrier: { failAfter: number | undefined };
  readonly store: MemoryDeviceKeyStore;
  readonly accepted: { keys: string[] };
  readonly oldKey: Awaited<ReturnType<typeof keyPair>>;
  readonly requests: { readonly request: RotatingRequest; readonly proven: boolean }[];
  readonly dialled: { readonly sockets: number };
  readonly credentials: { readonly t: string; readonly accepted: boolean }[];
}

const rig = async (
  options: {
    rotateBy?: string;
    /** What the daemon does with a step-up: swap to the proven key, or answer without one. */
    swap?: boolean;
    /** Lose the answer to the step-up after the daemon has acted on it. */
    dropAnswer?: boolean;
    rotation?: boolean;
  } = {},
): Promise<Rig> => {
  const identity = await newDaemonIdentity();
  const oldKey = await keyPair();
  const store = new MemoryDeviceKeyStore();
  await store.save(identity.daemonId, oldKey.privateKey);
  const accepted = { keys: [oldKey.publicKey] };
  const requests: Rig['requests'] = [];
  const route = rotatingDial(identity, {
    accepts: () => accepted.keys,
    ...(options.rotateBy === undefined ? {} : { rotateBy: () => options.rotateBy }),
    respond: async (request, session) => {
      const body = request.body === undefined ? undefined : (JSON.parse(request.body) as Record<string, unknown>);
      const rotation = DeviceKeyRotationSchema.safeParse(body?.rotation);
      const proven = rotation.success && (await session.daemon.provesRotation(rotation.data, session.deviceId));
      requests.push({ request, proven });
      if (request.path !== '/v1/step-up' && request.path !== '/v1/unlock') return { status: 200, body: {} };
      if (proven && rotation.success && options.swap !== false) accepted.keys = [rotation.data.deviceKey];
      if (options.dropAnswer === true) return 'drop';
      return {
        status: 200,
        body: {
          ...(request.path === '/v1/unlock' ? { unlockedUntil: FUTURE } : { expiresAt: FUTURE }),
          ...(proven && options.swap !== false ? { keyRotated: true } : {}),
        },
      };
    },
  });
  const carrier: Rig['carrier'] = { failAfter: undefined };
  const dial = (_url: string): ScriptedSocket => {
    if (carrier.failAfter === undefined || route.sockets.length < carrier.failAfter) return route.dial();
    const refused = new ScriptedSocket();
    queueMicrotask(() => refused.onClose?.(1006, 'the address did not answer'));
    return refused;
  };
  const connection = daemonConnection({ daemonId: identity.daemonId, baseUrl: URL_BASE, deviceId: DEVICE_ID });
  const router = new DaemonCarrierRouter({
    crypto: relayCrypto,
    dial,
    heartbeat: () => () => undefined,
    deviceKey: async daemonId => {
      const key = await store.load(daemonId);
      return key === undefined ? undefined : relayCrypto.deviceKeyHandle(key);
    },
    ...(options.rotation === false ? {} : { rotation: newRotation(store) }),
  });
  router.resolveByOrigin(origin => (origin === URL_BASE ? connection : undefined));
  return {
    router,
    daemonId: identity.daemonId,
    carrier,
    store,
    accepted,
    oldKey,
    requests,
    dialled: {
      get sockets() {
        return route.sockets.length;
      },
    },
    credentials: route.credentials,
  };
};

/** A read first, so the session is open and has told the router its `rotateBy`. */
const stepUp = async (test: Rig): Promise<Response> => {
  await test.router.fetch(`${URL_BASE}/v1/fleet`);
  return await test.router.fetch(STEP_UP, POST);
};

describe('the router carrying a rotation', () => {
  it('should send a rotation signed against the carrying session when rotateBy has passed, and promote on keyRotated', async () => {
    const test = await rig({ rotateBy: PAST });
    const pendingBefore = test.store.pending.size;

    const response = await stepUp(test);

    should(pendingBefore).equal(0);
    should(await response.json()).match({ keyRotated: true });
    const [, carried] = test.requests;
    should(carried?.proven).be.true();
    // The old key is gone for good: the NEW one is THE key and nothing is left pending.
    should(test.store.pending.size).equal(0);
    should(test.store.keys.get([...test.store.keys.keys()][0] ?? '')?.extractable).be.false();
    should(test.accepted.keys).not.eql([test.oldKey.publicKey]);
  });

  it('should rotate on the unlock that opens the app and promote on its keyRotated', async () => {
    const test = await rig({ rotateBy: PAST });
    await test.router.fetch(`${URL_BASE}/v1/fleet`);

    const response = await test.router.fetch(UNLOCK, POST);

    should(await response.json()).match({ keyRotated: true });
    should(test.requests[1]?.proven).be.true();
    should(test.store.pending.size).equal(0);
    should(test.accepted.keys).not.eql([test.oldKey.publicKey]);
  });

  it('should send nothing extra when rotateBy is still in the future, or the daemon asked for none', async () => {
    for (const rotateBy of [FUTURE, undefined]) {
      const test = await rig(rotateBy === undefined ? {} : { rotateBy });
      const response = await stepUp(test);
      should(await response.json()).not.have.property('keyRotated');
      should(test.requests[1]?.proven).be.false();
      should(test.store.pending.size).equal(0);
      should(test.accepted.keys).eql([test.oldKey.publicKey]);
    }
  });

  it('should send nothing extra from a router built without rotation, even when overdue', async () => {
    const test = await rig({ rotateBy: PAST, rotation: false });
    await stepUp(test);
    should(test.requests[1]?.proven).be.false();
    should(test.store.pending.size).equal(0);
  });

  it('should discard the pending key when the daemon answers without swapping', async () => {
    const test = await rig({ rotateBy: PAST, swap: false });
    const response = await stepUp(test);
    should(await response.json()).not.have.property('keyRotated');
    should(test.store.pending.size).equal(0);
    should(test.accepted.keys).eql([test.oldKey.publicKey]);
  });

  it('should keep the key it already holds when the request is not a step-up, however overdue', async () => {
    const test = await rig({ rotateBy: PAST });
    await test.router.fetch(`${URL_BASE}/v1/fleet`);
    await test.router.fetch(`${URL_BASE}/v1/fleet`);
    should(test.store.pending.size).equal(0);
    should([...test.store.keys.values()]).have.length(1);
  });

  it('should recover with the pending key when the answer was lost and the old key is now refused', async () => {
    const test = await rig({ rotateBy: PAST, dropAnswer: true });
    await test.router.fetch(`${URL_BASE}/v1/fleet`);
    // The daemon swaps, and the answer never arrives: the pending key is all that is left to open with.
    await should(test.router.fetch(STEP_UP, POST)).be.rejected();
    should(test.store.pending.size).equal(1);
    should(test.accepted.keys).not.eql([test.oldKey.publicKey]);

    const response = await test.router.fetch(`${URL_BASE}/v1/fleet`);

    should(response.status).equal(200);
    // Promoted: the pending slot is empty and the stored key is the one the daemon now accepts.
    should(test.store.pending.size).equal(0);
    const refused = test.credentials.filter(credential => !credential.accepted);
    should(refused).have.length(1);
    const accepted = test.credentials.filter(credential => credential.accepted);
    should(accepted.length).be.aboveOrEqual(2);
  });

  it('should discard the pending key when it is refused too, and report the original refusal', async () => {
    const test = await rig({ rotateBy: PAST, dropAnswer: true });
    await test.router.fetch(`${URL_BASE}/v1/fleet`);
    await should(test.router.fetch(STEP_UP, POST)).be.rejected();
    // The daemon holds some third key: neither the old nor the pending one is accepted.
    test.accepted.keys = [(await keyPair()).publicKey];
    const sessionsBefore = test.credentials.length;

    const refusal = await test.router.fetch(`${URL_BASE}/v1/fleet`).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    // The refusal of the device itself (4403), said as the one sentence the router gives it.
    should(refusal).be.instanceof(DeviceNotAcceptedError);
    should(test.store.pending.size).equal(0);
    // Exactly one retry with the pending key: two refused credentials, no more.
    should(test.credentials.length - sessionsBefore).equal(2);
    // And the original key is untouched, so a later repair can still use it.
    should(test.store.keys.size).equal(1);
  });

  it('should refuse once, without retrying, when there is no pending key', async () => {
    const test = await rig({});
    test.accepted.keys = [(await keyPair()).publicKey];
    const refusal = await test.router.fetch(`${URL_BASE}/v1/fleet`).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    // The refusal of the device itself (4403), said as the one sentence the router gives it.
    should(refusal).be.instanceof(DeviceNotAcceptedError);
    should(test.credentials).have.length(1);
  });

  it('should refuse once from a router that never rotates, even with a pending key stored', async () => {
    const test = await rig({ rotation: false });
    await test.store.savePending(test.daemonId, (await keyPair()).privateKey);
    test.accepted.keys = [(await keyPair()).publicKey];
    await should(test.router.fetch(`${URL_BASE}/v1/fleet`)).be.rejected();
    should(test.credentials).have.length(1);
  });

  it('should keep the pending key when the retry fails for a reason that is not a refusal', async () => {
    const test = await rig({ rotateBy: PAST, dropAnswer: true });
    await test.router.fetch(`${URL_BASE}/v1/fleet`);
    await should(test.router.fetch(STEP_UP, POST)).be.rejected();
    // The old key is refused, then the carrier fails under the pending key's attempt: that is a fact
    // about the carrier, not a verdict on the key, so the key must survive for the next session.
    test.carrier.failAfter = 2;
    await should(test.router.fetch(`${URL_BASE}/v1/fleet`)).be.rejected();
    should(test.store.pending.size).equal(1);
  });

  it('should report the original refusal when the pending key cannot even be read', async () => {
    const test = await rig({ rotateBy: PAST, dropAnswer: true });
    await test.router.fetch(`${URL_BASE}/v1/fleet`);
    await should(test.router.fetch(STEP_UP, POST)).be.rejected();
    test.store.loadPending = async () => {
      throw new Error('storage is blocked');
    };
    const refusal = await test.router.fetch(`${URL_BASE}/v1/fleet`).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    // The refusal of the device itself (4403), said as the one sentence the router gives it.
    should(refusal).be.instanceof(DeviceNotAcceptedError);
  });
});
