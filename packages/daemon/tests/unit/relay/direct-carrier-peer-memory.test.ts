/**
 * The direct carrier's per-address upgrade budget under an address flood.
 *
 * The daemon remembers each address's window so one host cannot loop handshakes; past a bound it forgets
 * windows that have already ended — and only those, so an address still inside its minute stays limited.
 */

import { beforeAll, describe, it } from 'bun:test';
import type { DaemonIdentity } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import should from 'should';
import { LiveDeviceConnections } from '../../../src/lib/pairing/index.ts';
import { DIRECT_UPGRADE_WINDOW_MS, DIRECT_UPGRADES_PER_PEER } from '../../../src/lib/relay/direct-carrier.ts';
import { directCarrierSocketRoute } from '../../../src/lib/runtime/mounts/direct-carrier.ts';
import { request } from '../api/support.ts';

/** The route's own bound on remembered addresses; it is private to the route, so a case restates it. */
const REMEMBERED_ADDRESSES = 4_096;

const crypto_ = new WebCryptoRelayCrypto();
let identity: DaemonIdentity;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  identity = await crypto_.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join('\n'),
  );
});

function route(now: () => number) {
  return directCarrierSocketRoute({
    crypto: crypto_,
    identity,
    dispatch: async () => ({ status: 200, headers: new Map(), body: '{}' }),
    sockets: { upgrade: async () => ({ outcome: 'unclaimed' }), reauthorize: () => true },
    devices: { deviceKey: async () => undefined, seen: () => undefined },
    pairing: { redeemInSession: async () => ({ kind: 'refused' }) },
    scheduler: { after: () => ({ cancel: () => undefined }) },
    clock: { now },
    connections: new LiveDeviceConnections(),
  });
}

describe('the direct carrier remembering the addresses that upgraded', () => {
  it('should forget windows that have ended once the memory is full, and keep the ones still open', async () => {
    // Arrange
    let now = 0;
    const carrier = route(() => now);
    const accept = async (address: string): Promise<unknown> =>
      await carrier.accept({
        request: request({
          path: `/v1/rendezvous/${identity.daemonId}/client`,
          clientAddress: address,
          loopback: true,
          privilegedLoopback: true,
        }),
        params: new Map([['daemonId', identity.daemonId]]),
      });
    // A host-proven carrier exempts an address from the unproven bound, so one address can spend its whole budget.
    // Every address the memory can hold upgrades once at time zero.
    for (let index = 0; index < REMEMBERED_ADDRESSES - 1; index += 1) await accept(`10.${index >> 8}.${index & 255}.1`);
    now = DIRECT_UPGRADE_WINDOW_MS / 2;
    for (let index = 0; index < DIRECT_UPGRADES_PER_PEER; index += 1) await accept('192.0.2.200');
    await accept('192.0.2.200').should.be.rejectedWith({ status: 429 });

    // Act — the first windows end, and one more address arrives to a full memory.
    now = DIRECT_UPGRADE_WINDOW_MS;
    should(await accept('192.0.2.201')).be.a.Function();

    // Assert — the address still inside its minute is still limited; an expired one starts afresh.
    await accept('192.0.2.200').should.be.rejectedWith({ status: 429 });
    should(await accept('10.0.0.1')).be.a.Function();
  });
});
