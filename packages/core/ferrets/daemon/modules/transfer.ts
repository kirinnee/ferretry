import type { StatePort } from '@ferretry/kernel/contract';
import {
  FileSessionAttachmentCopier,
  FileSessionTransferBriefWriter,
  FileSessionTransferTargetPlanStore,
} from '../adapters/transfer/index.ts';
import type { TransferAttachmentStore } from '../lib/transfer/ports.ts';
import type { BriefRoot } from '../adapters/transfer/brief-writer.ts';
import type { SessionId } from '../lib/session-id.ts';

/**
 * The three ports a fork needs to leave a transferred session behind: the target's plan, its first-turn brief and
 * its attachment copies.
 *
 * See `./session-fork.ts` for the composition that calls {@link transferPorts}. This file has no module of its own any
 * more: the attachment store, its originals adapter and the four attachment routes are Conversation's, not a
 * transfer's, so they are no longer built here. What stays is the construction of the three transfer-only ports, all
 * of which need nothing but the state port (the plan lives under the target ferret's own folder), the target's own
 * `sessions` folder (the brief is its turn one) and
 * the attachment owner's store (a port: the originals are Conversation's, GAP "unbound: TransferAttachmentStore —
 * owner Conversation").
 *
 * IT IS A FACTORY, called by the fork composition at the point it always made them, rather than built eagerly,
 * so their construction order and timing are unchanged. Pure construction: each call makes new instances,
 * touches no file and starts nothing.
 */

/** What {@link TransferProvides.transferPorts} is built from. */
export interface TransferPortsParts {
  /** Ferrets' own state: the target plan (`transfer-plan.json`) lives under it. */
  readonly state: StatePort;
  /**
   * A target's own private `sessions` handle: the brief IS the target's `turns/turn-001.md`, the file every turn reader
   * reads (the contract's `FERRET_SESSIONS_FOLDER`), never a second copy on the state port.
   */
  readonly briefs: (id: SessionId) => BriefRoot;
  /** The attachment owner's store: the source originals are read from it and the target's are written into it. */
  readonly attachments: TransferAttachmentStore;
}

/** The transfer-only ports the fork composition hands its binder. */
export interface TransferPorts {
  readonly planStore: FileSessionTransferTargetPlanStore;
  readonly briefWriter: FileSessionTransferBriefWriter;
  readonly attachmentCopier: FileSessionAttachmentCopier;
}

/** What other code may use from the transfer seam. */
export interface TransferProvides {
  /**
   * Constructs the fork's target plan store, brief writer and attachment copier. Pure construction over the given
   * ports: each call makes new instances, touches no file and starts nothing.
   */
  readonly transferPorts: (parts: TransferPortsParts) => TransferPorts;
}

/**
 * The fork wiring.
 *
 * TARGET-ONLY BY CONSTRUCTION. `FileSessionTransferTargetPlanStore` holds nothing but the target's own
 * `transfer-plan.json`, so the fork composition has no global transfer-receipt capability at all — the durable
 * fork receipt is `FileSessionForkReceiptStore`, and it is the single owner of that fact.
 */
export function transferPorts(parts: TransferPortsParts): TransferPorts {
  return {
    planStore: new FileSessionTransferTargetPlanStore(parts.state),
    briefWriter: new FileSessionTransferBriefWriter(parts.briefs),
    attachmentCopier: new FileSessionAttachmentCopier(parts.attachments),
  };
}
