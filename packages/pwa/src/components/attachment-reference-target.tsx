/**
 * Where the + on an attachment tile puts its reference: the composer of the surface the tile is drawn in.
 *
 * The chat page names its session's composer; an agenda card's view names that card's own (its draft slot),
 * so a + inside a card writes into the card's composer rather than the chat's. A tile outside any provider has
 * nowhere to write and draws no + at all. Whether a composer is actually open right now is read from the
 * composer registry, so the control is disabled — with the reason — while a question has replaced the box.
 */

import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import {
  composerQuoteTarget,
  composerTargetOpen,
  composerTargetsGeneration,
  subscribeComposerTargets,
} from '../lib/quote.ts';

const AttachmentReferenceTargetContext = createContext<DaemonSessionScope | null>(null);

export function AttachmentReferenceTarget({
  scope,
  children,
}: {
  readonly scope: DaemonSessionScope | null;
  readonly children: ReactNode;
}) {
  return (
    <AttachmentReferenceTargetContext.Provider value={scope}>{children}</AttachmentReferenceTargetContext.Provider>
  );
}

/** The composer scope a + here writes into, or null when this surface has none. */
export const useAttachmentReferenceTarget = (): DaemonSessionScope | null =>
  useContext(AttachmentReferenceTargetContext);

/** Whether a composer that takes a reference is mounted for this scope AND writable (not disabled, not sending) right now. */
export function useComposerOpen(scope: DaemonSessionScope | null): boolean {
  useSyncExternalStore(subscribeComposerTargets, composerTargetsGeneration);
  return scope !== null && composerTargetOpen(composerQuoteTarget(scope));
}
