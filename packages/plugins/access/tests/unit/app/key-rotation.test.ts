/**
 * Device-key rotation, browser half (`docs/design/zero-trust.md` B6).
 *
 * `KeyRotation` on its own, against real WebCrypto: when is a step-up amended, and what settles the pending key.
 * The carrier router carrying it (the proof rides the session it signed, and a refused old key falls back to the
 * pending one exactly once) is the app shell's session router, so those cases travel with the router's own suite.
 */

import { describe, it } from 'bun:test';
import { DeviceKeyRotationSchema } from '../../../contract/index.ts';
import should from 'should';
import { KeyRotation, type RotatingSession } from '../../../app/lib/key-rotation.ts';
import { toBase64Url } from '../../../app/shell-pairing.ts';
import { MemoryDeviceKeyStore, testDeviceKeyCrypto as relayCrypto } from '../../support/app/device-keys.ts';

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
  it('R248 adds a rotation, saved as pending BEFORE it is signed, once rotateBy has passed', async () => {
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

  it('R252 hands the pending key back as a handle for the one retry, and nothing when none is in flight', async () => {
    const { store } = await stored();
    const rotation = newRotation(store);
    should(await rotation.pending(daemon.daemonId)).not.be.undefined();
    await rotation.discard(daemon.daemonId);
    should(await rotation.pending(daemon.daemonId)).be.undefined();
    await rotation.promote(daemon.daemonId);
    should(store.keys.size).equal(1);
  });
});
