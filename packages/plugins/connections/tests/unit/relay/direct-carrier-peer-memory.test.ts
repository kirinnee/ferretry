/**
 * The direct carrier's per-address upgrade budget under an address flood.
 *
 * The daemon remembers each address's window so one host cannot loop handshakes; past a bound it forgets
 * windows that have already ended — and only those, so an address still inside its minute stays limited.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { ApiRequest } from '@ferretry/kernel/contract';
import { testArrival } from '../../../../../core/kernel/testing/admission.ts';
import { DIRECT_UPGRADE_WINDOW_MS, DIRECT_UPGRADES_PER_PEER } from '../../../daemon/lib/relay/direct-carrier.ts';
import { directCarrierSocketRoute } from '../../../daemon/lib/runtime/mounts/direct-carrier.ts';
const REMEMBERED_ADDRESSES = 4_096;
const identity = { daemonId: 'fy_daemon_' + 'a'.repeat(43) };
const request = (input: {
  path: string;
  clientAddress: string;
  loopback: boolean;
  privilegedLoopback: boolean;
}): ApiRequest => ({
  method: 'GET',
  path: input.path,
  clientAddress: input.clientAddress,
  headers: new Map(),
  query: new Map(),
  arrival: testArrival({ kind: 'ferret', id: 'fixture' }),
  text: async () => '',
});
function route(now: () => number) {
  return directCarrierSocketRoute({
    identity,
    randomBytes: (n: number) => new Uint8Array(n),
    sessions: () => {
      throw new Error('no session attaches in this admission fixture');
    },
    openSession: (layer, key, peer) => layer.open(key, peer),
    scheduler: { after: () => ({ cancel: () => undefined }) },
    clock: { now },
  });
}

describe('the direct carrier remembering the addresses that upgraded', () => {
  it('R33 should forget windows that have ended once the memory is full, and keep the ones still open', async () => {
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
