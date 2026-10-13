/**
 * A device key store in memory, for every suite above the key store itself.
 *
 * IndexedDB does not exist in the unit runtime, and the real store's behaviour is proved on its own
 * against a scripted factory. Everything else only needs a place keys go in and come back out of —
 * and a record of what was saved and removed, because "the key is saved only after the daemon
 * accepted it" and "unpairing forgets it" are both claims about exactly that.
 */

import type { DeviceKeyStore } from '../../src/lib/device-keys.ts';

export class MemoryDeviceKeyStore implements DeviceKeyStore {
  readonly keys = new Map<string, CryptoKey>();
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
  }
}
