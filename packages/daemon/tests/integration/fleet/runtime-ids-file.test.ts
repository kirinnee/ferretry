/**
 * `ids.json` as a start reads it: absent is "no old names", present is parsed, damaged refuses
 * naming the file — and the inventory that carries it answers the manifest's accounts unchanged.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { RuntimeAwareAccountInventory, RuntimeIdsFile } from '../../../src/adapters/fleet/runtime-ids-file.ts';
import type { CoreAccount, FileSystemPort } from '../../../src/lib/index.ts';

const PATH = '/state/fleet/ids.json';
const ID = '00000000-0000-4000-8000-0000000000aa';

/** Only the read this adapter makes; any other call is a defect in the adapter. */
const files = (text: string | undefined): FileSystemPort =>
  ({ readText: async (path: string) => (path === PATH ? text : undefined) }) as unknown as FileSystemPort;

describe('RuntimeIdsFile', () => {
  it('should answer nothing for a fleet with no ids.json', async () => {
    should(await new RuntimeIdsFile(files(undefined), PATH).ids()).be.undefined();
  });

  it('should parse the runtime names and their former names', async () => {
    // Arrange
    const text = JSON.stringify({ version: 1, runtimes: { reviewer: { id: ID, formerNames: ['claude-auto-review'] } } });

    // Act
    const actual = await new RuntimeIdsFile(files(text), PATH).ids();

    // Assert
    should(actual?.runtimes.reviewer).deepEqual({ id: ID, formerNames: ['claude-auto-review'] });
  });

  it('should refuse a damaged ids.json, naming the file', async () => {
    for (const text of ['{not json', JSON.stringify({ version: 9, runtimes: {} })]) {
      const error = await new RuntimeIdsFile(files(text), PATH).ids().then(
        () => undefined,
        (thrown: unknown) => thrown as Error,
      );
      should(error?.message.startsWith(`${PATH} could not be read: `)).be.true();
    }
  });
});

describe('RuntimeAwareAccountInventory', () => {
  it('should answer the inventory’s accounts and the runtime names side by side', async () => {
    // Arrange
    const accounts = [{ id: ID, agent: 'reviewer' } as unknown as CoreAccount];
    const subject = new RuntimeAwareAccountInventory(
      { accounts: async () => accounts },
      { ids: async () => ({ version: 1, runtimes: {} }) },
    );

    // Act + Assert
    should(await subject.accounts()).equal(accounts);
    should(await subject.ids()).deepEqual({ version: 1, runtimes: {} });
  });
});
