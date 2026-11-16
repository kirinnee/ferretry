import type { SessionId } from '../../../lib/session-id.ts';
import type { SessionCapabilityHashStore } from '../../../lib/session/lifecycle/index.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

const object = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

/**
 * Where a session's credential HASH lives: `capabilityHash` in its configuration document, never the plaintext (that
 * is in the environment store, on the `sessions` root). Every change is one locked merge, so a concurrent writer of
 * another field is never reverted. A person's cut-off is the same document's `credentialRevoked` mark.
 */
export class StorageSessionCapabilityHashStore implements SessionCapabilityHashStore {
  constructor(private readonly storage: DaemonStorage) {}

  async record(id: SessionId, hash: string): Promise<void> {
    await this.storage.updateConfig(id, current => ({ ...object(current), capabilityHash: hash }));
  }

  async erase(id: SessionId): Promise<void> {
    await this.storage.updateConfig(id, current => {
      const { capabilityHash: _revoked, ...rest } = object(current);
      return rest;
    });
  }

  async cutOff(id: SessionId): Promise<void> {
    await this.storage.updateConfig(id, current => {
      const { capabilityHash: _revoked, ...rest } = object(current);
      return { ...rest, credentialRevoked: true };
    });
  }

  async isCutOff(id: SessionId): Promise<boolean> {
    return object(await this.storage.readConfig(id)).credentialRevoked === true;
  }

  async restore(id: SessionId): Promise<void> {
    await this.storage.updateConfig(id, current => {
      const { credentialRevoked: _restored, ...rest } = object(current);
      return rest;
    });
  }
}
