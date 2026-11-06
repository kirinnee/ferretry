/**
 * Where the + on an attachment tile puts its reference: the composer of the surface the tile is drawn in.
 *
 * The chat page names its session's composer, and every tile drawn beneath it writes there. A surface with a
 * composer of its own could override the scope for what it draws (an agenda card's draft slot would be one);
 * that is future wiring, nothing provides one today. A tile outside any provider has nowhere to write and draws
 * no + at all. Whether a composer is actually open right now is read from the
 * composer registry, so the control is disabled — with the reason — while a question has replaced the box, the
 * box is switched off, or a send is in flight.
 */

import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import {
  type ComposerAvailability,
  composerQuoteTarget,
  composerTargetAvailability,
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

/**
 * Whether a composer that takes a reference is mounted for this scope AND writable right now (`open`), and when
 * it is not, why: no composer at all (`none`), or one that is `disabled` or `sending`.
 */
export function useComposerAvailability(scope: DaemonSessionScope | null): ComposerAvailability {
  useSyncExternalStore(subscribeComposerTargets, composerTargetsGeneration);
  return scope === null ? 'none' : composerTargetAvailability(composerQuoteTarget(scope));
}
