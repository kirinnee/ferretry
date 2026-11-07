/**
 * DEVICE-KEY ROTATION THROUGH THE SHELL'S SESSION (`docs/design/zero-trust.md` B6; R248, R252) — the go/no-go proof.
 *
 * Access's REAL claims and `KeyRotation` (the one implementation of the session layer's `SessionKeyRotation` port),
 * handed to the shell's REAL `connector`, over a REAL sealed session: real handshake, real device proofs, a real
 * rotation proof judged against the transcript of the session that carried it. Only the daemon is scripted, and it
 * holds the keys it accepts, so "the old key opens nothing after a swap" is a fact the suite can see.
 * Copied from today's router suite (`tests/unit/key-rotation.test.ts`, "the router carrying a rotation").
 */

import { describe, it } from 'bun:test';
import type { PairedDaemon } from '@ferretry/app';
import { connector, newDaemonIdentity, relayCrypto, rotatingDial, type RotatingRequest } from '@ferretry/app/testing';
import should from 'should';
import { accessClaims } from '../../../app/connect.ts';
import { DeviceKeyRotationSchema } from '../../../contract/index.ts';
import { toBase64Url } from '../../../app/shell-pairing.ts';
import { MemoryDeviceKeyStore } from '../../support/app/device-keys.ts';

const DEVICE_ID = 'fy_device_id_rotationTestDevice0000001';
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const PAST = '2026-10-01T00:00:00.000Z';
const FUTURE = '2026-11-01T00:00:00.000Z';
const ASSERTION = { credentialId: 'c', clientDataJSON: 'd', authenticatorData: 'a', signature: 's' };
const UNLOCK = { method: 'POST', path: '/v1/unlock', body: ASSERTION } as const;
const STEP_UP = { method: 'POST', path: '/v1/step-up', body: ASSERTION } as const;
const READ = { method: 'GET', path: '/v1/plugins' } as const;

/** The transport the shell's connector hands the generated client; closing it ends the session, so the next opens fresh. */
type DaemonTransport = NonNullable<Awaited<ReturnType<ReturnType<typeof connector>>>> & { close(): void };

const keyPair = async () => {
  const minted = await relayCrypto.generateDeviceKey();
  return { privateKey: minted.privateKey, publicKey: toBase64Url(minted.publicKeySpki) };
};

interface Rig {
  readonly transport: DaemonTransport;
  readonly daemonId: string;
  readonly store: MemoryDeviceKeyStore;
  readonly accepted: { keys: string[] };
  readonly oldKey: Awaited<ReturnType<typeof keyPair>>;
  readonly requests: { readonly request: RotatingRequest; readonly proven: boolean }[];
  readonly credentials: readonly { readonly t: string; readonly accepted: boolean }[];
  /** Dials from this count on fail as an unreachable carrier does; a refused leg walks on to a leg that fails. */
  readonly carrier: { failFrom: number | undefined; onwardFails: boolean };
}

const rig = async (
  options: {
    /** What the daemon does with a proven rotation: swap to the new key, or answer without one. */
    readonly swap?: boolean;
    /** Lose the answer to the unlock or step-up after the daemon has acted on it. */
    readonly dropAnswer?: boolean;
    /** Whether the daemon says the key is due at all. */
    readonly due?: boolean;
  } = {},
): Promise<Rig> => {
  const identity = await newDaemonIdentity();
  const oldKey = await keyPair();
  const store = new MemoryDeviceKeyStore();
  await store.save(identity.daemonId, oldKey.privateKey);
  const accepted = { keys: [oldKey.publicKey] };
  const requests: Rig['requests'] = [];
  const carrier: Rig['carrier'] = { failFrom: undefined, onwardFails: false };
  const route = rotatingDial(identity, {
    accepts: () => accepted.keys,
    // Due until the daemon swapped; the swapped key is due a period later.
    rotateBy: () => (options.due === false ? undefined : accepted.keys.includes(oldKey.publicKey) ? PAST : FUTURE),
    failFrom: () => carrier.failFrom,
    onwardFails: () => carrier.onwardFails,
    respond: async (request, session) => {
      const body = request.body === undefined ? undefined : (JSON.parse(request.body) as Record<string, unknown>);
      const rotation = DeviceKeyRotationSchema.safeParse(body?.rotation);
      const proven = rotation.success && (await session.daemon.provesRotation(rotation.data, session.deviceId));
      requests.push({ request, proven });
      if (request.path !== '/v1/step-up' && request.path !== '/v1/unlock') return { status: 200, body: {} };
      // The daemon's own rule (`step-up/service.ts#ceremony`): a due key with no rotation is refused.
      if (options.due !== false && accepted.keys.includes(oldKey.publicKey) && !rotation.success) {
        return { status: 403, body: { error: 'rotation required', code: 'step_up_rotation_required' } };
      }
      const swapped = proven && rotation.success && options.swap !== false;
      if (swapped) accepted.keys = [rotation.data.deviceKey];
      if (options.dropAnswer === true) return 'drop';
      return {
        status: 200,
        body: {
          ...(request.path === '/v1/unlock' ? { unlockedUntil: FUTURE } : { expiresAt: FUTURE }),
          ...(swapped ? { keyRotated: true } : {}),
        },
      };
    },
  });
  const claims = accessClaims(
    { crypto: relayCrypto, indexedDB: null },
    { store, appSession: 'page-1', now: () => NOW },
  );
  const daemon: PairedDaemon = {
    daemon: identity.daemonId,
    machine: 'workstation',
    deviceId: DEVICE_ID,
    address: 'https://daemon.example.test',
    carriers: [],
    pairedAt: 1,
    lastSelectedAt: 1,
  };
  const transport = await connector({ crypto: relayCrypto, claims, carriers: [], direct: () => route.dial })(daemon);
  if (transport === undefined || !('close' in transport) || typeof transport.close !== 'function')
    throw new Error('the device holds a key, so the shell reaches the daemon over one session transport');
  return {
    transport: transport as DaemonTransport,
    daemonId: identity.daemonId,
    store,
    accepted,
    oldKey,
    requests,
    credentials: route.credentials,
    carrier,
  };
};

/** The key the store holds now, as the public half the daemon would know it by. */
const storedIsNotOld = (test: Rig): boolean => !test.accepted.keys.includes(test.oldKey.publicKey);

describe('a paired device past rotateBy, through the shell session', () => {
  it('R248 rotates inside the next unlock, still unlocks, then steps up, and a fresh session proves the new key', async () => {
    const test = await rig();

    const unlocked = await test.transport.request(UNLOCK);

    should(unlocked.status).equal(200);
    should(unlocked.body).match({ keyRotated: true });
    // The proof rode the session it signed (the daemon judged it against that transcript), with no extra request.
    should(test.requests.map(seen => `${seen.request.method} ${seen.request.path} ${seen.proven}`)).eql([
      'POST /v1/unlock true',
    ]);
    should(test.store.pending.size).equal(0);
    should(storedIsNotOld(test)).be.true();
    should(test.store.keys.get(test.daemonId)?.extractable).be.false();

    // A step-up after the swap still works: on the live session, and on a fresh one the NEW key opens.
    should((await test.transport.request(STEP_UP)).status).equal(200);
    test.transport.close();
    const stepped = await test.transport.request(STEP_UP);
    should(stepped.status).equal(200);
    should(stepped.body).not.have.property('keyRotated');
    // Every credential the daemon saw was accepted: the old key never had to be tried after the swap.
    should(test.credentials.every(credential => credential.accepted)).be.true();
    should(test.credentials.length).be.aboveOrEqual(2);
  });

  it('R248 rotates inside a step-up the same way, and the device is never refused for want of a rotation', async () => {
    const test = await rig();
    await test.transport.request(READ);

    const stepped = await test.transport.request(STEP_UP);

    should(stepped.status).equal(200);
    should(stepped.body).match({ keyRotated: true });
    should(test.requests[1]?.proven).be.true();
    should(test.store.pending.size).equal(0);
    // The daemon's `step_up_rotation_required` refusal was never earned: nothing it answered was a 403.
    should(storedIsNotOld(test)).be.true();
  });

  it('R248 sends nothing extra when the daemon asked for no rotation', async () => {
    const test = await rig({ due: false });
    const unlocked = await test.transport.request(UNLOCK);
    should(unlocked.body).not.have.property('keyRotated');
    should(test.requests[0]?.proven).be.false();
    should(test.store.pending.size).equal(0);
    should(test.accepted.keys).eql([test.oldKey.publicKey]);
  });

  it('R252 a discarded rotation leaves the old key working', async () => {
    const test = await rig({ swap: false });

    const unlocked = await test.transport.request(UNLOCK);

    // The daemon answered without swapping: the pending key is discarded and the old one is still THE key.
    should(unlocked.body).not.have.property('keyRotated');
    should(test.store.pending.size).equal(0);
    should(test.accepted.keys).eql([test.oldKey.publicKey]);
    test.transport.close();
    should((await test.transport.request(READ)).status).equal(200);
    should(test.credentials.every(credential => credential.accepted)).be.true();
  });

  it('R252 recovers with the pending key once when the answer was lost and the old key is now refused', async () => {
    const test = await rig({ dropAnswer: true });
    // The daemon swaps, and the answer never arrives: the pending key is all that is left to open with.
    await should(test.transport.request(UNLOCK)).be.rejected();
    should(test.store.pending.size).equal(1);
    should(storedIsNotOld(test)).be.true();

    const read = await test.transport.request(READ);

    should(read.status).equal(200);
    // Promoted: the pending slot is empty and the stored key is the one the daemon now accepts.
    should(test.store.pending.size).equal(0);
    should(test.credentials.filter(credential => !credential.accepted)).have.length(1);
    // And every session after it proves the promoted key first time.
    test.transport.close();
    should((await test.transport.request(READ)).status).equal(200);
    should(test.credentials.filter(credential => !credential.accepted)).have.length(1);
  });

  it('R252 discards the pending key when it is refused too, and reports the original refusal', async () => {
    const test = await rig({ dropAnswer: true });
    await should(test.transport.request(UNLOCK)).be.rejected();
    // The daemon holds some third key: neither the old nor the pending one is accepted.
    test.accepted.keys = [(await keyPair()).publicKey];
    const before = test.credentials.length;

    const refusal = await test.transport.request(READ).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    should(refusal).match({ code: 4403 });
    should(test.store.pending.size).equal(0);
    // Exactly one retry with the pending key: two refused credentials, no more.
    should(test.credentials.length - before).equal(2);
    // The original key is untouched, so a later repair can still use it.
    should(test.store.keys.get(test.daemonId)).equal(test.oldKey.privateKey);
  });

  it('R252 keeps the pending key when the retry fails for a reason that is not a refusal', async () => {
    const test = await rig({ dropAnswer: true });
    await should(test.transport.request(UNLOCK)).be.rejected();
    // The old key is refused, then the carrier fails under the pending key's attempt: a fact about the carrier,
    // not a verdict on the key, so the key must survive for the next session.
    test.carrier.failFrom = 2;
    await should(test.transport.request(READ)).be.rejected();
    should(test.store.pending.size).equal(1);
  });

  it('R252 tries the pending key once and promotes it when a refusal on the first leg is followed by a failing leg', async () => {
    const test = await rig({ dropAnswer: true });
    await should(test.transport.request(UNLOCK)).be.rejected();
    should(test.store.pending.size).equal(1);
    // Leg one refuses the old key; the carrier walks on to a leg that fails (the hosted relay is down).
    test.carrier.onwardFails = true;
    const before = test.credentials.length;

    const read = await test.transport.request(READ);

    should(read.status).equal(200);
    // Exactly one refused credential (the old key) and one accepted (the pending key): tried once, never a loop.
    should(test.credentials.slice(before).map(credential => credential.accepted)).eql([false, true]);
    should(test.store.pending.size).equal(0);
    should(storedIsNotOld(test)).be.true();
  });

  it('R252 discards the pending key when a refusal on the first leg is followed by a failing leg, and the pending key is refused too', async () => {
    const test = await rig({ dropAnswer: true });
    await should(test.transport.request(UNLOCK)).be.rejected();
    test.accepted.keys = [(await keyPair()).publicKey];
    test.carrier.onwardFails = true;
    const before = test.credentials.length;

    const refusal = await test.transport.request(READ).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    // The walk reports the refusal, not the later leg's carrier failure, and the pending key is tried once.
    should(refusal).match({ code: 4403 });
    should(test.credentials.length - before).equal(2);
    should(test.store.pending.size).equal(0);
    should(test.store.keys.get(test.daemonId)).equal(test.oldKey.privateKey);
  });

  it('R252 refuses once, without retrying, when there is no pending key', async () => {
    const test = await rig();
    test.accepted.keys = [(await keyPair()).publicKey];
    const refusal = await test.transport.request(READ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should(refusal).match({ code: 4403 });
    should(test.credentials).have.length(1);
  });
});
