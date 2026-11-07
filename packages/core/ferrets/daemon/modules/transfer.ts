import { join } from 'node:path';
import { decryptPdfInMemory, FileAttachmentOriginals } from '../../src/adapters/attachments/index.ts';
import {
  FileSessionAttachmentCopier,
  FileSessionTransferBriefWriter,
  FileSessionTransferTargetPlanStore,
} from '../adapters/transfer/index.ts';
import {
  attachmentDirectory,
  createSessionPaths,
  type FoundationPaths,
  parseSessionId,
  SessionAttachmentStore,
  sessionScopedAttachments,
} from '../../src/lib/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { sessionAttachmentRoutes } from '../../src/lib/runtime/mounts/session-attachments.ts';

/**
 * The files a session carries with it: the durable attachment originals, the process-local unlock state over them and the
 * four attachment routes (upload, download, unlock, lock).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries: the originals adapter and the in-memory PDF decryption are fixed production adapters; the state
 * directory, the daemon identity and the session directory are needs), no jobs and no releases of its own: the store holds
 * no timer until a document is unlocked (the eviction is armed by that unlock, unref'd, never by the build), so the build
 * only captures its inputs. It claims no audit rule and no protocol feature.
 *
 * THE SESSION TRANSFER SEAM IS COMPOSED BY THE FORK, NOT BUILT HERE. Its only production composition is the fork's
 * (`createForkSubsystem` in `fyd.ts`), which is session code and stays with the sessions: the preparer, the envelope
 * writer (it takes the session storage), the target resolver, the binder and the service. What is transfer-only is the three
 * ports that need nothing but a path resolver (the target plan store, the brief writer and the attachment copier);
 * {@link TransferProvides.transferPorts} constructs them. It is a FACTORY, called by `createForkSubsystem` at the point it
 * always made them, rather than built eagerly with the module, so their construction order and timing are unchanged.
 *
 * What it provides is read by code that stays in `fyd.ts`: the board's attachment carrier, the session control that zeroes
 * a stopped session's plaintext, the fork's attachment reader and copier, the send's attachment delivery and the agent
 * tools' file access. They take {@link TransferProvides.store} and {@link TransferProvides.originals}.
 */

/** What the transfer module is built from. */
export interface TransferNeeds {
  /** The state home's directory: the attachment tree lives under it, `<state>/attachments/<daemonId>/<sessionId>`. */
  readonly stateDirectory: string;
  /**
   * This daemon's durable pairing identity, already proven by the caller (`fyd.ts` throws "pairing identity was not
   * opened before attachment mounting" before the build when it is not open yet).
   */
  readonly daemonId: string;
  /** The session directory: a route answers `not_found` for a session it no longer holds. */
  readonly sessions: { readonly get: (sessionId: string) => Promise<unknown> };
}

/** What {@link TransferProvides.transferPorts} is built from: the two fork-side path facts the ports address. */
interface TransferPortsParts {
  /** The foundation paths: the target plan and the brief live in the session's own private directory. */
  readonly paths: FoundationPaths;
  /** The ONE resolver for the attachment tree (`TransferProvides.originals`) the copier writes into. */
  readonly attachmentOriginals: (sessionId: string) => string;
}

/** The transfer-only ports the fork composition hands its binder. */
interface TransferPorts {
  readonly planStore: FileSessionTransferTargetPlanStore;
  readonly briefWriter: FileSessionTransferBriefWriter;
  readonly attachmentCopier: FileSessionAttachmentCopier;
}

/** What other code may use from the transfer module. */
export interface TransferProvides {
  /** The attachment store itself: the board, the session control, the fork, the send delivery and the agent tools read it. */
  readonly store: SessionAttachmentStore;
  /**
   * The ONE resolver for this daemon's attachment tree: the store's originals adapter and the fork's copier both take it,
   * so neither can address a directory the other never reads.
   */
  readonly originals: (sessionId: string) => string;
  /**
   * Constructs the fork's target plan store, brief writer and attachment copier. Pure construction over the given paths:
   * each call makes new instances, touches no file and starts nothing.
   */
  readonly transferPorts: (parts: TransferPortsParts) => TransferPorts;
}

/** The moved fork wiring, verbatim; see {@link TransferProvides.transferPorts}. */
function transferPorts(parts: TransferPortsParts): TransferPorts {
  /**
   * The target's own `transfer-plan.json`, installed before import and re-read on every replay.
   *
   * TARGET-ONLY BY CONSTRUCTION. `FileSessionTransferTargetPlanStore` holds nothing but this
   * document, so the fork composition has no global transfer-receipt capability at all — the durable
   * fork receipt is `FileSessionForkReceiptStore`, and it is the single owner of that fact.
   */
  const planStore = new FileSessionTransferTargetPlanStore(id =>
    join(createSessionPaths(parts.paths, id).directory, 'transfer-plan.json'),
  );
  const briefWriter = new FileSessionTransferBriefWriter(
    id => createSessionPaths(parts.paths, parseSessionId(id)).directory,
  );
  const attachmentCopier = new FileSessionAttachmentCopier(parts.attachmentOriginals);
  return { planStore, briefWriter, attachmentCopier };
}

export const transferModule: DaemonModule<void, TransferNeeds, TransferProvides> = {
  id: 'transfer',
  build: needs => {
    const originals = (id: string): string => attachmentDirectory(needs.stateDirectory, needs.daemonId, id);
    const store = new SessionAttachmentStore({
      daemonId: needs.daemonId,
      originals: new FileAttachmentOriginals(originals),
      decrypt: decryptPdfInMemory,
      // An unlocked plaintext nobody reads again is still zeroed at its expiry, not at process exit.
      // Unref'd, so a pending eviction never holds the daemon open.
      scheduleEviction: (delayMs, evict) => {
        setTimeout(evict, delayMs).unref();
      },
    });
    // A session that is gone, or is stopped through the control route, has its plaintext zeroed.
    const sessionAttachments = sessionScopedAttachments(
      store,
      async id => (await needs.sessions.get(id)) !== undefined,
    );
    return {
      id: 'transfer',
      provides: { store, originals, transferPorts },
      jobs: {},
      contributes: {
        // Attachment routes are mounted before sends may honour attachment ids. Their
        // deeper unlock path cannot shadow this one-segment upload route.
        routes: sessionAttachmentRoutes(sessionAttachments),
      },
    };
  },
};
