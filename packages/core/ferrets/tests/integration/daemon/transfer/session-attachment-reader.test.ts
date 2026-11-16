import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AttachmentInventory,
  SessionAttachmentTransferReader,
} from '../../../../daemon/adapters/transfer/session-attachment-reader.ts';
import type { TransferAttachmentView } from '../../../../daemon/lib/transfer/ports.ts';

/**
 * The inventory a transfer plan pins is read through the attachment owner's store and nothing else.
 *
 * The store's own behaviour — the on-disk layout, the manifest parse, a torn upload being skipped, an unlocked
 * original reported as locked — is Conversation's and is pinned by its tests. What belongs here is the binding: the
 * transfer reads exactly what the owner lists for the source session, adds and removes nothing, and lets the owner's
 * refusal reach the caller, because a plan must not silently omit what the owner could not describe.
 */

const AT = '2026-08-06T09:00:00.000Z';

const view = (name: string, overrides: Partial<TransferAttachmentView> = {}): TransferAttachmentView => ({
  id: `att_${name.repeat(64)}`,
  filename: `${name}.txt`,
  mime: 'text/plain',
  size: 17,
  sha256: name.repeat(64),
  createdAt: AT,
  ...overrides,
});

describe('SessionAttachmentTransferReader', () => {
  it('should report the identity, size and content hash the owner lists, in the owner order', async () => {
    // Arrange
    const asked: string[] = [];
    const listed = [view('a'), view('b', { encrypted: { kind: 'pdf', locked: true } })];
    const inventory: AttachmentInventory = {
      list: async sessionId => {
        asked.push(sessionId);
        return listed;
      },
    };

    // Act
    const actual = await new SessionAttachmentTransferReader(inventory).list('20260806-source');

    // Assert: the source session was asked, and its inventory came back unchanged.
    should(asked).eql(['20260806-source']);
    should(actual).eql(listed);
  });

  it('should answer an empty inventory for a session that has never attached anything', async () => {
    // Arrange
    const inventory: AttachmentInventory = { list: async () => [] };

    // Act
    const actual = await new SessionAttachmentTransferReader(inventory).list('20260806-empty');

    // Assert
    should(actual).be.empty();
  });

  it('should let the owner refuse an inventory it cannot describe completely', async () => {
    // Arrange: a manifest that will not parse is bytes the owner cannot describe.
    const refusal = Object.assign(new Error('attachment manifest is invalid'), { failure: 'corrupt' });
    const inventory: AttachmentInventory = {
      list: async () => {
        throw refusal;
      },
    };

    // Act
    const failure = await new SessionAttachmentTransferReader(inventory).list('20260806-source').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).equal(refusal);
  });
});
