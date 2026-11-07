/**
 * The source session's durable attachment inventory, read through the store that owns it.
 *
 * Implements `TransferAttachmentReader` (the attachments facet's only port). It is a thin binding on
 * purpose: `SessionAttachmentStore` already owns the on-disk layout, the manifest parse and the
 * content-address rule, and a transfer that re-derived any of them would be a second definition of
 * the same durable format — the failure mode being an inventory that disagrees with the store the
 * bytes are actually copied out of.
 *
 * WHAT THE PLAN NEEDS IS EXACTLY WHAT A MANIFEST HOLDS: the content-addressed id, the sha256, the
 * byte size, and whether the original is encrypted. Preparation pins the first three into the plan so
 * import can refuse bytes that changed underneath it, and turns the fourth into the `credential`
 * omission that tells the new session's operator they will be asked for the password again.
 *
 * NO UNLOCK STATE CROSSES THIS BOUNDARY, and the store's `list` is what guarantees it: the decrypted
 * plaintext cache is per session and is never enumerated, so a source with a document unlocked right
 * now is described exactly as one that has never been unlocked. A transfer must not be able to widen
 * a guarantee the product makes deliberately narrow.
 *
 * There is no read of bytes here at all. Originals are copied daemon-locally at import by
 * `TransferAttachmentCopier`, against the identity this inventory pinned.
 */

import type { AttachmentView } from '@ferretry/protocol';
import type { SessionAttachmentStore } from '../../lib/attachments/session-attachments.ts';
import type { TransferAttachmentReader } from '../../lib/transfer/types.ts';

export class SessionAttachmentTransferReader implements TransferAttachmentReader {
  constructor(private readonly store: SessionAttachmentStore) {}

  async list(sessionId: string): Promise<readonly AttachmentView[]> {
    return await this.store.list(sessionId);
  }
}
