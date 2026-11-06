import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import { LiveDeviceConnections } from '../../../../src/lib/pairing/index.ts';
import { directCarrierSocketRoute } from '../../../../src/lib/runtime/mounts/direct-carrier.ts';

/** Only admission is exercised: the attachment never opens a cryptographic session. */
export const surfaceCarrier = () =>
  directCarrierSocketRoute({
    crypto: new WebCryptoRelayCrypto(),
    identity: { daemonId: 'snapshot-daemon', publicKeySpki: new Uint8Array(), privateKey: { algorithm: 'Ed25519' } },
    dispatch: async () => ({ status: 200, headers: new Map(), body: '{}' }),
    sockets: { upgrade: async () => ({ outcome: 'unclaimed' }), reauthorize: () => true },
    devices: { deviceKey: async () => undefined, seen: () => undefined },
    pairing: { redeemInSession: async () => ({ kind: 'refused' }) },
    scheduler: { after: () => ({ cancel: () => undefined }) },
    clock: { now: () => 0 },
    connections: new LiveDeviceConnections(),
  });
