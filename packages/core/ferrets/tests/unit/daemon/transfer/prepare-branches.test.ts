import { describe, expect, it } from 'bun:test';
import type { WorkspaceFacet } from '@ferretry/protocol';
import { SessionTransferPreparer } from '../../../src/lib/transfer/prepare.ts';
import { TransferPrepareError } from '../../../src/lib/transfer/types.ts';
import { request, sourceSession } from './fixtures.ts';

describe('SessionTransferPreparer plan validation', () => {
  it('refuses a contributor answer the payload forbids, naming the source and the offending path', async () => {
    // Arrange
    const malformed = { cwd: 7, head: null, status: null, repositorySnapshot: null } as unknown as WorkspaceFacet;
    const subject = new SessionTransferPreparer({
      source: { read: async () => sourceSession() },
      selection: { verifySelection: async () => true },
      contributors: {
        conversation: {
          facet: 'conversation',
          contribute: async () => ({
            value: {
              messages: [{ point: { v: 1, byteOffset: 512, blockIndex: 0 }, role: 'user', text: 'ship it' }],
            },
            omissions: [],
            selectionEvidence: { rawPrefix: Uint8Array.from([1, 2, 3]) },
          }),
        },
        attachments: { facet: 'attachments', contribute: async () => ({ value: { attachments: [] }, omissions: [] }) },
        references: {
          facet: 'references',
          contribute: async () => ({
            value: { counts: { agent: 0, file: 0, task: 0, attention: 0, skill: 0, terminal: 0, browser: 0 } },
            omissions: [],
          }),
        },
        workspace: { facet: 'workspace', contribute: async () => ({ value: malformed, omissions: [] }) },
        lineage: {
          facet: 'lineage',
          contribute: async () => ({ value: { wardenLineage: false, warden: null }, omissions: [] }),
        },
      },
    });

    // Act
    const error = (await subject.prepare(request()).catch((thrown: unknown) => thrown)) as TransferPrepareError;

    // Assert
    expect(error).toBeInstanceOf(TransferPrepareError);
    expect(error.failure).toBe('plan_invalid');
    expect(error.message).toContain('the transfer plan for source-a is not a valid payload');
    expect(error.message).toContain('facets.workspace.cwd');
  });
});
