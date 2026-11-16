import { describe, it } from 'bun:test';
import type { RootHandle } from '@ferretry/kernel/contract';
import { instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import { HeldFastCatalog } from '../../daemon/adapters/held-catalog.ts';

describe('HeldFastCatalog', () => {
  it('should hold nothing, and not fail, when the catalog kept on disk cannot be read', async () => {
    // Arrange — the seam to the plugin's state throws, as it does for a damaged file.
    const catalog = new HeldFastCatalog({
      workspace: {} as unknown as RootHandle,
      environment: async () => undefined,
      locate: async () => ({ outcome: 'absent', searched: [] }),
      read: async () => [],
      nowMs: () => 0,
      now: () => instantFromEpochMs(0),
      load: async () => {
        throw new Error('the held catalog is damaged');
      },
      save: async () => undefined,
      requestRefresh: () => undefined,
      warn: () => undefined,
    });

    // Act
    await catalog.loaded();

    // Assert
    should(catalog.held()).be.undefined();
  });
});
