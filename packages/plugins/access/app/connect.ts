/**
 * WHAT ACCESS PROVIDES THE APP SHELL (`provideToShell`, §4.8, §4.13): the DEVICE CLAIMS.
 *
 * The shell holds no device key. For each session it asks Access which grant this device proves on that daemon and
 * signs the session's transcript through the handle it gets back; a handle is never serialised and never leaves the
 * page. Access keeps the keys: IndexedDB `fy-access` (§9.4), one non-extractable Ed25519 key per daemon, the same
 * store the rotation and the pairing exchange use (`lib/device-keys.ts`).
 */
import type { ConnectPorts, DeviceClaims, PairingKey } from '@ferretry/app';
import { PairingResponseSchema } from '../contract/index.ts';
import {
  DeviceKeyUnreadableError,
  type DeviceKeyStore,
  IndexedDbDeviceKeyStore,
  mintDeviceKey,
} from './lib/device-keys.ts';
import { browserDeviceName } from './lib/device-name.ts';

export interface AccessClaimsOptions {
  /** Where the keys live. The page's IndexedDB by default. */
  readonly store?: DeviceKeyStore;
  /** Random per page load: a step-up the daemon grants belongs to one of these. */
  readonly appSession?: string;
  /** The name a fresh pairing key is offered under until the person changes it. */
  readonly deviceName?: () => string;
}

/** The pieces of the ports the claims read. */
export type ClaimPorts = Pick<ConnectPorts, 'crypto' | 'indexedDB'>;

/** The store the claims, the rotation and the pairing exchange all share. */
export const accessKeyStore = (ports: Pick<ConnectPorts, 'indexedDB'>): DeviceKeyStore =>
  new IndexedDbDeviceKeyStore(ports.indexedDB ?? undefined);

export function accessClaims(ports: ClaimPorts, options: AccessClaimsOptions = {}): DeviceClaims {
  const store = options.store ?? accessKeyStore(ports);
  const appSession = options.appSession ?? crypto.randomUUID();
  const deviceName = options.deviceName ?? browserDeviceName;
  return {
    claim: async daemon => {
      let key: CryptoKey | undefined;
      try {
        key = await store.load(daemon.daemon);
      } catch (reason) {
        // The key may be there and unreachable (a private window): not the same as a missing key.
        throw new DeviceKeyUnreadableError(reason);
      }
      if (key === undefined) return undefined;
      return { deviceId: daemon.deviceId, key: ports.crypto.deviceKeyHandle(key), appSession };
    },
    pairingKey: async (daemonId): Promise<PairingKey> => {
      const minted = await mintDeviceKey(ports.crypto);
      // MEMORY-ONLY until the shell has the sealed `paired` answer and calls `save` (P28): a refused or unreachable
      // attempt never calls it, so a refused code leaves nothing in IndexedDB and a re-pair of a known daemon keeps the
      // key that still works until the daemon has accepted the new one.
      return {
        deviceName: deviceName(),
        publicKey: minted.publicKey,
        key: ports.crypto.deviceKeyHandle(minted.privateKey),
        save: async response => {
          const parsed = PairingResponseSchema.parse(response);
          if (parsed.daemonId !== daemonId) {
            throw new Error('pairing response daemon ID does not match the daemon this key was minted for');
          }
          // One put: the previous key is replaced in a single write, never absent in between.
          await store.save(daemonId, minted.privateKey);
        },
      };
    },
    forget: async daemonId => {
      await store.remove(daemonId);
    },
  };
}
