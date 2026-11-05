/**
 * `%attachment:name` for one session's conversation: the index its tiles fill and the reference surface that
 * reads it.
 *
 * Mounted ONCE where the daemon and the session are known (`AttachmentReferences`, under the hand-off source),
 * it holds the session's `AttachmentIndex` and layers an attachment resolver and opener onto whatever reference
 * surface is already above it. A message that carries files layers a second one over its own text
 * (`AttachmentReferenceSurface local=…`), so a reference written in a message resolves to THAT message's own
 * file before a newer file of the same name — the rule `attachment-references.ts` states.
 *
 * Outside a session workspace there is no index, and every part of this is a pass-through: a token stays text.
 */

import { createContext, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  AttachmentIndex,
  type AttachmentReferenceScope,
  createAttachmentReferenceResolver,
  type IndexedAttachment,
  revealAttachmentTile,
} from '../lib/attachment-references.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { ReferenceSurfaceProvider, useReferenceSurface } from './reference-surface.tsx';

interface HeldIndex {
  readonly scope: AttachmentReferenceScope;
  readonly index: AttachmentIndex;
}

const HeldIndexContext = createContext<HeldIndex | null>(null);

const never = (): (() => void) => () => undefined;
const zero = (): number => 0;

/** Layers the attachment resolver and opener onto the surface above, over `local` files first. */
export function AttachmentReferenceSurface({
  local,
  children,
}: {
  readonly local?: readonly IndexedAttachment[];
  readonly children: ReactNode;
}) {
  const held = useContext(HeldIndexContext);
  const outer = useReferenceSurface();
  // A file recorded after this text painted must be able to prove it: the version is what re-renders the readers.
  const version = useSyncExternalStore(held?.index.subscribe ?? never, held?.index.version ?? zero);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` stands for what the index holds
  const surface = useMemo(
    () =>
      held === null
        ? outer
        : {
            ...outer,
            attachmentReferenceResolver: createAttachmentReferenceResolver(held.scope, held.index, local),
            onAttachmentOpen: (reference: { readonly attachmentId: string }, opener?: HTMLElement | null): void => {
              revealAttachmentTile(document, reference.attachmentId, opener);
            },
          },
    [held, local, outer, version],
  );
  return held === null ? children : <ReferenceSurfaceProvider surface={surface}>{children}</ReferenceSurfaceProvider>;
}

/** The session's attachment index, and the surface that proves `%attachment:` against it. */
export function AttachmentReferences({
  daemonId,
  sessionId,
  children,
}: {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
  readonly children: ReactNode;
}) {
  // One index per daemon and session: a file of one conversation proves nothing in another.
  const held = useMemo<HeldIndex>(
    () => ({ scope: { daemonId, sessionId }, index: new AttachmentIndex() }),
    [daemonId, sessionId],
  );
  return (
    <HeldIndexContext.Provider value={held}>
      <AttachmentReferenceSurface>{children}</AttachmentReferenceSurface>
    </HeldIndexContext.Provider>
  );
}

/** Records the stored files a message carries, once they are on screen. */
export function useRecordAttachments(message: string, files: readonly IndexedAttachment[]): void {
  const held = useContext(HeldIndexContext);
  useEffect(() => {
    held?.index.record(message, files);
  }, [held, message, files]);
}
