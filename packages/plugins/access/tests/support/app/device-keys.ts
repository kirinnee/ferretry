/**
 * A device key store in memory, for every suite above the key store itself.
 *
 * IndexedDB does not exist in the unit runtime, and the real store's behaviour is proved on its own
 * against a scripted factory. Everything else only needs a place keys go in and come back out of —
 * and a record of what was saved and removed, because "the key is saved only after the daemon
 * accepted it" and "unpairing forgets it" are both claims about exactly that.
 */

import type { DeviceKeyStore } from '../../../app/lib/device-keys.ts';
import type { KeyRotationCrypto } from '../../../app/lib/key-rotation.ts';
import type { PrivateKeyHandle } from '../../../app/shell-pairing.ts';

/** A key handle a suite can unwrap again, so it can check which key a session was asked to sign with. */
export interface TestKeyHandle extends PrivateKeyHandle {
  readonly key: CryptoKey;
}

/**
 * The two WebCrypto calls device keys need, as today's `WebCryptoRelayCrypto` makes them: a NON-EXTRACTABLE Ed25519
 * pair with the public half exported as SPKI, and a handle around a stored private key. Real keys, so whether a key
 * survives as a `CryptoKey` and whether it can be exported are facts a suite can check.
 */
export const testDeviceKeyCrypto: KeyRotationCrypto = {
  async generateDeviceKey() {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as unknown as CryptoKeyPair;
    return {
      publicKeySpki: new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
      privateKey: pair.privateKey,
    };
  },
  deviceKeyHandle(key: CryptoKey): TestKeyHandle {
    return { algorithm: 'Ed25519', key };
  },
};

export class MemoryDeviceKeyStore implements DeviceKeyStore {
  readonly keys = new Map<string, CryptoKey>();
  readonly pending = new Map<string, CryptoKey>();
  readonly saved: string[] = [];
  readonly removed: string[] = [];

  async load(daemonId: string): Promise<CryptoKey | undefined> {
    return this.keys.get(daemonId);
  }

  async save(daemonId: string, key: CryptoKey): Promise<void> {
    this.saved.push(daemonId);
    this.keys.set(daemonId, key);
  }

  async remove(daemonId: string): Promise<void> {
    this.removed.push(daemonId);
    this.keys.delete(daemonId);
    this.pending.delete(daemonId);
  }

  async loadPending(daemonId: string): Promise<CryptoKey | undefined> {
    return this.pending.get(daemonId);
  }

  async savePending(daemonId: string, key: CryptoKey): Promise<void> {
    this.pending.set(daemonId, key);
  }

  async promotePending(daemonId: string): Promise<boolean> {
    const key = this.pending.get(daemonId);
    if (key === undefined) return false;
    this.keys.set(daemonId, key);
    this.pending.delete(daemonId);
    return true;
  }

  async discardPending(daemonId: string): Promise<void> {
    this.pending.delete(daemonId);
  }
}
