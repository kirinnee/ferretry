/**
 * WHAT A PRESS OF "RESTART OUTDATED" CHANGED, shared by everything in the list that draws an outdated ferret.
 *
 * The daemon's answer says which ferrets restarted now and which wait for an idle moment, but the list only catches up on
 * its next refresh. Until it does, the rows must already say so: a restarted ferret drops its "Outdated" mark, a queued one
 * reads "Queued", and the press's count stops including both. The overlay is that answer, held for the page; the daemon's
 * own `outdated` flag stays the source of truth, so once the list refreshes the overlay only repeats it.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import type { FerretSummary, RestartResult } from '../../../contract/index.ts';

interface RestartOverlay {
  readonly restarted: ReadonlySet<string>;
  readonly queued: ReadonlySet<string>;
}

interface RestartOverlayControls {
  readonly overlay: RestartOverlay;
  /** Remember what a restart did. */
  readonly record: (result: RestartResult) => void;
  /** Forget it: the rows go back to what the daemon says. */
  readonly clear: () => void;
}

const EMPTY: RestartOverlay = { restarted: new Set(), queued: new Set() };

const RestartOverlayContext = createContext<RestartOverlayControls>({
  overlay: EMPTY,
  record: () => {},
  clear: () => {},
});

export function RestartOverlayProvider({ children }: { readonly children: ReactNode }) {
  const [overlay, setOverlay] = useState<RestartOverlay>(EMPTY);
  const record = useCallback(
    (result: RestartResult) =>
      setOverlay({
        restarted: new Set(result.restarted.map(entry => entry.id)),
        queued: new Set(result.queued.map(entry => entry.id)),
      }),
    [],
  );
  const clear = useCallback(() => setOverlay(EMPTY), []);
  const value = useMemo(() => ({ overlay, record, clear }), [overlay, record, clear]);
  return <RestartOverlayContext.Provider value={value}>{children}</RestartOverlayContext.Provider>;
}

export const useRestartOverlay = (): RestartOverlayControls => useContext(RestartOverlayContext);

/** What the mark says for one ferret: the daemon's word, "Queued" once a restart is waiting, or nothing. */
type OutdatedState = 'outdated' | 'queued' | 'restarted';

export const outdatedState = (ferret: FerretSummary, overlay: RestartOverlay): OutdatedState =>
  overlay.restarted.has(ferret.id) ? 'restarted' : overlay.queued.has(ferret.id) ? 'queued' : 'outdated';
