/** Pairing order copied from today's relay-pairing tests and store.exchangePairing save boundary. */
import { expect, test } from 'bun:test';
import { pairOverDirect } from '../../../src/connect/connector.ts';
import {
  PAIRING_REFUSED_REASON,
  RelayPairingRefusedError,
  RelaySessionError,
} from '../../../src/session/session-client.ts';
import type { CarrierSocketEvents } from '../../../src/session/session-transport.ts';
import { decodeFrame, FRAME_KINDS, SESSION_PROTOCOL_ID } from '../../../src/session/wire/index.ts';
import {
  controlFrame,
  newDaemonIdentity,
  readyFrame,
  relayCrypto,
  ScriptedDaemon,
  testDevice,
  testSessionId,
} from '../../support/relay.ts';

const device = await testDevice();
const response = { deviceId: 'fy_dev_paired', machine: 'Work' };

async function pairing() {
  const identity = await newDaemonIdentity();
  const sessionId = testSessionId();
  const daemon = new ScriptedDaemon(identity, sessionId);
  const saved = new Map<string, CryptoKey>();
  const writes: unknown[] = [];
  const pairSent = Promise.withResolvers<void>();
  let events!: CarrierSocketEvents;
  let queue = Promise.resolve();
  const pair = pairOverDirect(relayCrypto, () => listeners => {
    events = listeners;
    queueMicrotask(() => events.onBinary(readyFrame(sessionId)));
    return {
      send(bytes) {
        const copy = Uint8Array.from(bytes);
        queue = queue
          .then(async () => {
            const decoded = decodeFrame(copy);
            if (!decoded.ok) return;
            if (decoded.frame.kind === FRAME_KINDS.handshake) {
              events.onBinary(await daemon.answer(copy));
            } else if (decoded.frame.kind === FRAME_KINDS.data) {
              const record = (await daemon.receive(copy)) as Record<string, unknown>;
              expect(record.t).toBe('pair');
              expect(await daemon.proves(record, device.publicKey)).toBe(true);
              expect(saved.size).toBe(0);
              pairSent.resolve();
            }
          })
          .catch(pairSent.reject);
      },
      sendText() {},
      close() {},
    };
  });
  const pending = pair({
    address: 'https://daemon.example',
    daemonId: identity.daemonId,
    code: 'ABCD-EFGH',
    key: {
      deviceName: 'phone',
      publicKey: device.publicKey,
      key: device.claim.key,
      save: async answer => {
        writes.push(answer);
        saved.set(identity.daemonId, device.privateKey);
      },
    },
  });
  // Attach before any scripted failure can arrive.
  void pending.catch(() => {});
  await pairSent.promise;
  const end = (inBand: boolean, reason: string): void => {
    if (inBand) events.onBinary(controlFrame(sessionId, { t: 'closed', code: 4440, reason }));
    else events.onClose(4440, reason);
  };
  return { daemon, events, pending, saved, writes, identity, end };
}

test('P28 saves the non-extractable key only after the sealed paired answer', async () => {
  const attempt = await pairing();
  expect(attempt.saved.size).toBe(0);
  attempt.events.onBinary(await attempt.daemon.record({ t: 'paired', protocol: SESSION_PROTOCOL_ID, response }));
  expect(await attempt.pending).toEqual({ kind: 'paired', response });
  expect(attempt.saved.get(attempt.identity.daemonId)).toBe(device.privateKey);
  expect(device.privateKey.extractable).toBe(false);
  expect(attempt.writes).toEqual([response]);
});

test('P28 a refused or unreachable pairing leaves no saved key', async () => {
  for (const refused of [true, false]) {
    const attempt = await pairing();
    if (refused) {
      attempt.events.onBinary(
        await attempt.daemon.record({
          t: 'pair-refused',
          protocol: SESSION_PROTOCOL_ID,
          reason: PAIRING_REFUSED_REASON,
        }),
      );
      await expect(attempt.pending).rejects.toBeInstanceOf(RelayPairingRefusedError);
    } else {
      attempt.events.onClose(1006, 'unreachable');
      await expect(attempt.pending).rejects.toBeInstanceOf(RelaySessionError);
    }
    expect(attempt.saved.size).toBe(0);
    expect(attempt.writes).toEqual([]);
  }
});

test('R575 latches the sealed outcome before a close arriving during decryption', async () => {
  for (const [refused, inBand] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    const attempt = await pairing();
    const record = refused
      ? { t: 'pair-refused', protocol: SESSION_PROTOCOL_ID, reason: PAIRING_REFUSED_REASON }
      : { t: 'paired', protocol: SESSION_PROTOCOL_ID, response };
    attempt.events.onBinary(await attempt.daemon.record(record));
    // The carrier does not await the asynchronous decrypt before reporting its close.
    attempt.end(inBand, 'concluded');
    if (refused) {
      await expect(attempt.pending).rejects.toBeInstanceOf(RelayPairingRefusedError);
      expect(attempt.writes).toEqual([]);
    } else {
      expect(await attempt.pending).toEqual({ kind: 'paired', response });
      expect(attempt.writes).toEqual([response]);
    }
  }
});

test('R575 a 4440 without a sealed outcome is a protocol violation, even with a close reason', async () => {
  for (const [reason, inBand] of [
    ['', false],
    ['', true],
    ['concluded', false],
    ['concluded', true],
  ] as const) {
    const attempt = await pairing();
    attempt.end(inBand, reason);
    await expect(attempt.pending).rejects.toThrow('without stating an outcome inside the channel');
    expect(attempt.saved.size).toBe(0);
    expect(attempt.writes).toEqual([]);
  }
});
