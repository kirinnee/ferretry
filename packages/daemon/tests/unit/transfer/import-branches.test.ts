import { describe, expect, it } from 'bun:test';
import { SessionTransferImporter } from '../../../src/lib/transfer/import.ts';
import { TransferImportError } from '../../../src/lib/transfer/types.ts';
import { plan } from './fixtures.ts';

describe('SessionTransferImporter cut provenance', () => {
  it('refuses a cut whose plan froze no transcript provenance, before any port is touched', async () => {
    // Arrange
    const calls: string[] = [];
    const writers = {
      conversation: {
        digestPinned: async () => {
          calls.push('reread');
          return undefined;
        },
      },
      envelope: {
        apply: async () => {
          calls.push('envelope');
        },
      },
      brief: {
        write: async () => {
          calls.push('brief');
          return '/state/sessions/target-b/turns/turn-001.md';
        },
      },
      attachments: {
        copyOriginal: async () => {
          calls.push('copy');
        },
      },
    };
    const base = plan();
    const unpinned = plan({ source: { ...base.source, transcriptProvenance: null } });

    // Act
    const error = (await new SessionTransferImporter(writers, 'fork')
      .importPlan(unpinned, 'target-b')
      .catch((thrown: unknown) => thrown)) as TransferImportError;

    // Assert
    expect(error).toBeInstanceOf(TransferImportError);
    expect(error.failure).toBe('cut_unreadable');
    expect(error.message).toContain(`plan ${unpinned.planId} has no frozen transcript provenance`);
    expect(calls).toEqual([]);
  });
});
