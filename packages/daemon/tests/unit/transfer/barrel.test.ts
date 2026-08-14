import { describe, expect, it } from 'bun:test';
import * as transfer from '../../../src/lib/transfer/index.ts';

describe('the transfer seam barrel', () => {
  it('exposes both halves and every facet contributor under one entry', () => {
    expect(Object.keys(transfer).sort()).toEqual([
      'AttachmentFacetContributor',
      'ConversationFacetContributor',
      'LineageFacetContributor',
      'ReferenceFacetContributor',
      'SESSION_TRANSFER_IMPORT_PORTS',
      'SESSION_TRANSFER_PREPARE_PORTS',
      'SessionTransferImporter',
      'SessionTransferPreparer',
      'TransferImportError',
      'TransferPrepareError',
      'WorkspaceFacetContributor',
      'deriveTransferPlanId',
      'renderTransferBrief',
    ]);
  });
});
