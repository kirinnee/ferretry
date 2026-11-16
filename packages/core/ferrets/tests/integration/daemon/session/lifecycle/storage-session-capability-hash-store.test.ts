import { describe, it } from 'bun:test';
import should from 'should';
import { StorageSessionCapabilityHashStore } from '../../../../../daemon/adapters/session/lifecycle/storage-session-capability-hash-store.ts';
import { parseSessionId } from '../../../../../daemon/lib/session-id.ts';
import { memoryStorage, sessionConfig } from '../../../../support/daemon/storage.ts';

/**
 * Where a session's credential HASH lives: `capabilityHash` in its configuration document, through the session store's
 * locked merge. The plaintext is never here, and a person's cut-off is the same document's `credentialRevoked` mark.
 */

const SESSION = parseSessionId('20260806-capability');

async function stored() {
  const { storage } = await memoryStorage();
  await storage.writeConfig(SESSION, sessionConfig(SESSION));
  return { storage, hashes: new StorageSessionCapabilityHashStore(storage) };
}

const configOf = async (storage: Awaited<ReturnType<typeof stored>>['storage']) =>
  (await storage.readConfig(SESSION)) as Record<string, unknown>;

describe('StorageSessionCapabilityHashStore', () => {
  it('should keep the hash beside the other fields of the configuration without reverting them', async () => {
    // Arrange
    const { storage, hashes } = await stored();

    // Act
    await hashes.record(SESSION, 'a'.repeat(64));
    const document = await configOf(storage);

    // Assert
    should(document.capabilityHash).equal('a'.repeat(64));
    should(document.name).equal('zelda');
  });

  it('should not call a session that has no configuration cut off', async () => {
    // Arrange
    const { storage } = await memoryStorage();

    // Act
    const cut = await new StorageSessionCapabilityHashStore(storage).isCutOff(SESSION);

    // Assert
    should(cut).equal(false);
  });

  it('should erase the hash and nothing else', async () => {
    // Arrange
    const { storage, hashes } = await stored();
    await hashes.record(SESSION, 'a'.repeat(64));

    // Act
    await hashes.erase(SESSION);
    const document = await configOf(storage);

    // Assert
    should(document.capabilityHash).be.undefined();
    should(document.name).equal('zelda');
  });

  it('should cut a credential off for good: its hash gone, the mark set, until a person restores it', async () => {
    // Arrange
    const { storage, hashes } = await stored();
    await hashes.record(SESSION, 'a'.repeat(64));
    const before = await hashes.isCutOff(SESSION);

    // Act
    await hashes.cutOff(SESSION);
    const during = await hashes.isCutOff(SESSION);
    const cut = await configOf(storage);
    await hashes.restore(SESSION);
    const after = await hashes.isCutOff(SESSION);

    // Assert
    should(before).equal(false);
    should(during).equal(true);
    should(cut.capabilityHash).be.undefined();
    should(cut.credentialRevoked).equal(true);
    should(after).equal(false);
  });
});
