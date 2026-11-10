/**
 * THE WHOLE CLAIM, FROM THE BROWSER'S END (R209, R184, and R201's Linux proof): the browser's own walk and router, the
 * REAL rendezvous Durable Object, and the daemon's REAL relay link over the REAL kernel session layer — three
 * implementations of one protocol, with real WebCrypto at every corner. The assertion that matters is not "it worked":
 *
 *     THE RENDEZVOUS FORWARDED EVERY BYTE AND COULD NOT READ ONE OF THEM.
 *
 * Every frame the rendezvous handled is kept (`RendezvousBridge.observed`) and the device id, its public key, the
 * pairing code, the device name and the request and answer bodies are searched for across all of them, as raw bytes.
 * Only the browser's socket and timers are scripted; the rendezvous, the link and the sessions are the code that ships.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  PairingOutcomeUnknownError,
  type PairDirectInput,
  type PairedDaemon,
  RelayPairingRefusedError,
  toBase64Url,
} from '@ferretry/app';
import { connector, fakeDeviceClaims, pairOverCarriers, WebCryptoRelayCrypto } from '@ferretry/app/testing';
import { jsonResponse } from '@ferretry/kernel/contract';
import { FRAME_KINDS } from '@ferretry/kernel/wire';
import type { BrowserSocket } from '../../../app/adapters/browser-relay-dial.ts';
import { CarrierRouter } from '../../../app/carriers/router.ts';
import { pairingWalk } from '../../../app/pairing/walk.ts';
import { BrowserNetwork, HandTimers } from '../../support/browser-network.ts';
import { type KernelFixture, kernelFixture, type PairedTestDevice } from '../../support/kernel-session.ts';
import { carrierLeaks, RELAY_ORIGIN, RendezvousBridge } from '../../support/rendezvous-bridge.ts';

const shellCrypto = new WebCryptoRelayCrypto();
const DIRECT = 'https://laptop.example.test';
const SECRET_ANSWER = 'the answer a relay operator may not read';
const REQUEST_PATH = '/v1/ferrets/fy_private_listing';
const PAIRING_CODE = 'K7Q2-M9XW';
const DEVICE_NAME = 'phone-of-the-owner';

const bridges: RendezvousBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
});

/** A daemon and its rendezvous slot, admitted, with a browser that can dial only the rendezvous. */
async function relayed(): Promise<{ readonly fx: KernelFixture; readonly bridge: RendezvousBridge }> {
  const fx = await kernelFixture();
  const bridge = new RendezvousBridge();
  bridges.push(bridge);
  await bridge.admitDaemon(fx);
  return { fx, bridge };
}

/** An authenticated request, as a paired device sends it through the router's relay carrier. */
async function requestOver(
  fx: KernelFixture,
  bridge: RendezvousBridge,
  path: string,
): Promise<{ readonly answer: unknown; readonly device: PairedTestDevice }> {
  const device = await fx.paired();
  fx.route = async () => jsonResponse({ answer: SECRET_ANSWER });
  const timers = new HandTimers();
  const router = new CarrierRouter({
    openSocket: bridge.openSocket,
    after: timers.after,
    now: () => 0,
    preference: () => 'relay',
    hostedRelay: async () => undefined,
  });
  const daemon: PairedDaemon = {
    daemon: fx.daemonId,
    machine: 'laptop',
    deviceId: device.deviceId,
    address: DIRECT,
    carriers: [{ kind: 'relay', url: RELAY_ORIGIN }],
    pairedAt: 1,
    lastSelectedAt: 1,
  };
  const claims = fakeDeviceClaims({
    claims: {
      [fx.daemonId]: {
        deviceId: device.deviceId,
        key: shellCrypto.deviceKeyHandle(device.privateKey),
        appSession: device.appSession,
      },
    },
  });
  const transport = await connector({
    crypto: shellCrypto,
    claims,
    carriers: [router.dialer()],
    direct: () => {
      throw new Error('the shell’s own direct dial is not used once Connections registered a carrier');
    },
  })(daemon);
  if (transport === undefined) throw new Error('no transport');
  const answer: unknown = await transport.request({ method: 'GET', path });
  await bridge.settle();
  return { answer, device };
}

/** The pairing walk over the rendezvous: the direct address does not answer, so the one discovered rendezvous carries. */
async function pairOver(
  fx: KernelFixture,
  bridge: RendezvousBridge,
  save: PairDirectInput['key']['save'] = () => Promise.resolve(),
): Promise<{ readonly input: PairDirectInput; readonly outcome: Promise<unknown> }> {
  const timers = new HandTimers();
  const dead = new BrowserNetwork(fx, { [new URL(DIRECT).host]: { kind: 'dead' } });
  const openSocket = (url: string): BrowserSocket =>
    new URL(url).host === new URL(DIRECT).host ? dead.openSocket(url) : bridge.openSocket(url);
  const walk = pairingWalk({ openSocket, after: timers.after, hostedRelay: async () => RELAY_ORIGIN });
  const noDirect = () => {
    throw new Error('the shell’s own direct dial is not used once Connections registered a walk');
  };
  const minted = await shellCrypto.generateDeviceKey();
  const input: PairDirectInput = {
    address: DIRECT,
    daemonId: fx.daemonId,
    code: PAIRING_CODE,
    key: {
      deviceName: DEVICE_NAME,
      publicKey: toBase64Url(minted.publicKeySpki),
      key: shellCrypto.deviceKeyHandle(minted.privateKey),
      save,
    },
  };
  return { input, outcome: pairOverCarriers(shellCrypto, noDirect, timers.after, () => walk)(input) };
}

describe('a relayed session, browser to daemon, through the real rendezvous', () => {
  test('R209 a request and its answer cross the rendezvous without it reading the device, the key, the path or the body', async () => {
    // Arrange
    const { fx, bridge } = await relayed();

    // Act — an authenticated request through the router's relay carrier.
    const { answer, device } = await requestOver(fx, bridge, REQUEST_PATH);

    // Assert — it was really served, over the relay arrival, by the daemon's own route table...
    expect(fx.requests.map(request => request.path)).toEqual([REQUEST_PATH]);
    expect(fx.requests[0]?.arrival).toMatchObject({ kind: 'carried', carrier: 'relay' });
    expect(JSON.stringify(answer)).toContain(SECRET_ANSWER);
    // ...and the rendezvous, which carried every frame, could read none of what mattered.
    expect(bridge.observed.length).toBeGreaterThan(4);
    expect(
      carrierLeaks(bridge, {
        'the device id the session proved': device.deviceId,
        'a device public key the daemon holds': device.publicKey,
        'the name of the credential field': 'deviceId',
        'the answer body': SECRET_ANSWER,
        'the route the request asked for': REQUEST_PATH,
      }),
    ).toEqual([]);
    // The fingerprint IS visible: it addresses the rendezvous, and the protocol says so.
    expect(bridge.dialled[0]).toContain(fx.daemonId);
  });

  test('R209 the leak search is not vacuous: a value planted in one frame is found, by label and index, never by value', () => {
    const planted = new TextEncoder().encode(`frame carrying ${PAIRING_CODE} in the clear`);
    const found = carrierLeaks(
      { observed: [new Uint8Array([1, 2, 3]), planted] },
      { 'the pairing code': PAIRING_CODE },
    );
    expect(found).toEqual(['the pairing code appeared in relay-observable frame #1']);
    expect(found.join()).not.toContain(PAIRING_CODE);
    expect(() => carrierLeaks({ observed: [] }, { empty: '' })).toThrow('empty needle');
  });
});

describe('first pairing through the real rendezvous', () => {
  test('R209 a first pairing is redeemed over the rendezvous without it reading the code, the name, the key or the grant', async () => {
    // Arrange
    const { fx, bridge } = await relayed();

    // Act
    const { input, outcome } = await pairOver(fx, bridge);
    const paired = (await outcome) as { readonly kind: string; readonly via: { readonly kind: string } };
    await bridge.settle();

    // Assert — the daemon redeemed exactly what the browser sent, proving the browser holds the key it registered...
    expect(paired).toMatchObject({ kind: 'paired', via: { kind: 'relay' } });
    expect(fx.pair.attempts).toHaveLength(1);
    expect(fx.pair.attempts[0]).toMatchObject({
      carrier: 'relay',
      proof: { mode: 'pair', body: { code: PAIRING_CODE, deviceName: DEVICE_NAME, deviceKey: input.key.publicKey } },
    });
    // ...and the rendezvous carried all of it while reading none.
    expect(bridge.observed.length).toBeGreaterThan(4);
    expect(
      carrierLeaks(bridge, {
        'the pairing code': PAIRING_CODE,
        'the device name the browser sent': DEVICE_NAME,
        'the public key being registered': input.key.publicKey,
        'the minted device id': 'fy_device_id_new',
      }),
    ).toEqual([]);
  });

  test('R201 the journey — pair, then ask — leaves the code, the key, the grant, the name and the payload out of every rendezvous frame', async () => {
    // Arrange — one rendezvous carries the whole journey, as it does for a real phone.
    const { fx, bridge } = await relayed();

    // Act
    const { input, outcome } = await pairOver(fx, bridge);
    await outcome;
    await requestOver(fx, bridge, REQUEST_PATH);

    // Assert — nothing the journey sent or received is in any frame the rendezvous handled, in either direction.
    expect(fx.pair.attempts).toHaveLength(1);
    expect(fx.requests).toHaveLength(1);
    expect(
      carrierLeaks(bridge, {
        'the pairing code': PAIRING_CODE,
        'the device public key': input.key.publicKey,
        'the minted grant': 'fy_device_id_new',
        'the device name': DEVICE_NAME,
        'the request path': REQUEST_PATH,
        'the answer payload': SECRET_ANSWER,
      }),
    ).toEqual([]);
  });

  test('R184 a byte flipped in the sealed paired record by the rendezvous is refused: nothing is saved and no grant is believed', async () => {
    // Arrange — a rendezvous that edits the first sealed record it hands the browser (the daemon's `paired` answer).
    const { fx, bridge } = await relayed();
    let flipped = 0;
    bridge.meddle = bytes => {
      if (bytes[2] !== FRAME_KINDS.data || flipped > 0) return undefined;
      flipped += 1;
      const edited = Uint8Array.from(bytes);
      edited[edited.length - 1] = (edited[edited.length - 1] ?? 0) ^ 0xff;
      return edited;
    };
    const saved: string[] = [];

    // Act
    const { outcome } = await pairOver(fx, bridge, async () => {
      saved.push('saved');
    });
    const failure = await (outcome as Promise<unknown>).catch((error: unknown) => error);

    // Assert — the daemon did redeem (the code is spent), but the browser refused the altered answer: it believes no
    // pairing, saves no key, and never reads the edit as a published carrier set.
    expect(flipped).toBe(1);
    expect(fx.pair.attempts).toHaveLength(1);
    expect(failure).toBeInstanceOf(PairingOutcomeUnknownError);
    expect(failure).not.toBeInstanceOf(RelayPairingRefusedError);
    expect(saved).toEqual([]);
  });
});
