/**
 * WHAT ACCESS PROVIDES THE APP SHELL (`provideToShell`, §4.8, §4.13): the DEVICE CLAIMS.
 *
 * The shell holds no device key. For each session it asks Access which grant this device proves on that daemon and
 * signs the session's transcript through the handle it gets back; a handle is never serialised and never leaves the
 * page. Access keeps the keys: IndexedDB `fy-access` (§9.4), one non-extractable Ed25519 key per daemon, the same
 * store the rotation and the pairing exchange use (`lib/device-keys.ts`). The ROTATION rides with the claims: today's
 * `KeyRotation` over that same store (`lib/key-rotation.ts`), which the shell's session applies inside the next unlock or
 * step-up once the daemon says the key is due (R248) and falls back to once on a refused session (R252).
 */
import { type ConnectPorts, type DeviceClaims, type PairingKey, toBase64Url } from '@ferretry/app';
import { PairingResponseSchema } from '../contract/index.ts';
import {
  DeviceKeyUnreadableError,
  type DeviceKeyStore,
  IndexedDbDeviceKeyStore,
  mintDeviceKey,
} from './lib/device-keys.ts';
import { browserDeviceName } from './lib/device-name.ts';
import { KeyRotation } from './lib/key-rotation.ts';

export interface AccessClaimsOptions {
  /** Where the keys live. The page's IndexedDB by default. */
  readonly store?: DeviceKeyStore;
  /** Random per page load: a step-up the daemon grants belongs to one of these. */
  readonly appSession?: string;
  /** The name a fresh pairing key is offered under until the person changes it. */
  readonly deviceName?: () => string;
  /** Epoch milliseconds, for when a rotation is due. A parameter so a suite can place `rotateBy` either side of it. */
  readonly now?: () => number;
}

/** The pieces of the ports the claims read. */
export type ClaimPorts = Pick<ConnectPorts, 'crypto' | 'indexedDB'>;

/** The store the claims, the rotation and the pairing exchange all share. */
export const accessKeyStore = (ports: Pick<ConnectPorts, 'indexedDB'>): DeviceKeyStore =>
  new IndexedDbDeviceKeyStore(ports.indexedDB ?? undefined);

/** Bytes in the page-load id a session names itself with: `docs/relay-protocol.md` §14, "16 random bytes, base64url". */
const APP_SESSION_BYTES = 16;

/**
 * The name of THIS page load, in the shape the daemon's record decoder accepts and nothing else.
 *
 * It was `crypto.randomUUID()` — 36 characters, hyphens and all — and the daemon refuses any `auth` or
 * `stream` record whose `appSession` is not exactly 22 base64url characters, so every session this page
 * opened died at its first record with "unparseable session record".
 */
function pageLoadSession(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(APP_SESSION_BYTES)));
}

export function accessClaims(ports: ClaimPorts, options: AccessClaimsOptions = {}): DeviceClaims {
  const store = options.store ?? accessKeyStore(ports);
  const appSession = options.appSession ?? pageLoadSession();
  const deviceName = options.deviceName ?? browserDeviceName;
  // Today's `rotation: new KeyRotation({ store: deviceKeys, crypto })`: one rotation over the claims' own store.
  const rotation = new KeyRotation({
    store,
    crypto: ports.crypto,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    rotation,
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
