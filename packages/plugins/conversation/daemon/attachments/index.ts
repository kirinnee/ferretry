import type { Clock, StatePort, WorkersPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { decryptPdfInMemory } from './adapters/decrypt-pdf.ts';
import { StateAttachmentOriginals } from './adapters/originals.ts';
import { AttachmentStore, ferretScopedAttachments } from './lib/ferret-attachments.ts';
import { downloadRoute, lockRoute, unlockRoute, uploadRoute } from './routes.ts';

export { ATTACHMENT_MANIFEST_STATE, ATTACHMENT_ORIGINAL_STATE } from './adapters/state.ts';
export { decryptPdfInMemory, probePdfDecryptWorker } from './adapters/decrypt-pdf.ts';
export * from './lib/index.ts';

export interface AttachmentsNeeds {
  readonly state: Pick<StatePort, 'read' | 'write' | 'list' | 'remove'>;
  readonly workers: Pick<WorkersPort, 'start'>;
  readonly clock: Pick<Clock, 'now' | 'nowMs' | 'after'>;
  readonly ferrets: Pick<FerretsApi, 'get'>;
}

/** The attachments: the store (durable originals, process-local plaintext), its four routes and the release of a ferret's plaintext. */
export function buildAttachments(needs: AttachmentsNeeds) {
  const store = new AttachmentStore({
    originals: new StateAttachmentOriginals(needs.state),
    decrypt: (encrypted, password) => decryptPdfInMemory(needs, encrypted, password),
    now: () => new Date(needs.clock.nowMs()),
    scheduleEviction: (delayMs, evict) => {
      needs.clock.after(milliseconds(delayMs), evict);
    },
  });
  const scoped = ferretScopedAttachments(
    store,
    async ferret => (await needs.ferrets.get(ferret as FerretId)) !== undefined,
  );
  return {
    store,
    scoped,
    routes: {
      'POST /v1/ferrets/:ferretId/attachments': uploadRoute(scoped),
      'GET /v1/ferrets/:ferretId/attachments/:attachmentId': downloadRoute(scoped),
      'POST /v1/ferrets/:ferretId/attachments/:attachmentId/unlock': unlockRoute(scoped),
      'DELETE /v1/ferrets/:ferretId/attachments/:attachmentId/unlock': lockRoute(scoped),
    },
    /** Zeroes and forgets every plaintext a ferret holds: called when it stops or is gone. */
    release: (ferret: string): void => store.releaseFerret(ferret),
  } as const;
}
