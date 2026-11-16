/**
 * WHAT A PRESS OF "RESTART OUTDATED" CHANGED, shared by everything of one daemon that draws an outdated ferret: the list's rows
 * and the current ferret's Info › Overview.
 *
 * The daemon's answer says which ferrets restarted now and which wait for an idle moment, but the list only catches up on
 * its next refresh. Until it does, the marks must already say so: a restarted ferret drops its "Outdated" mark, a queued one
 * reads "Queued", and the press's count stops including both. The overlay is that answer, held for the page; the daemon's own
 * `outdated` flag stays the source of truth, so once the list refreshes the overlay only repeats it.
 *
 * KEYED BY THE DAEMON'S CLIENT: the shell builds one half per daemon with that daemon's own client, and every view of the half
 * (the list screen, the Info panel) holds that same object, so two paired daemons never share an answer even when they hold a
 * ferret with the same id. A view with no key (a test that draws a row alone) has no overlay and shows the daemon's word.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { FerretSummary, RestartResult } from '../../../contract/index.ts';

interface RestartOverlay {
  readonly restarted: ReadonlySet<string>;
  readonly queued: ReadonlySet<string>;
}

interface RestartOverlayControls {
  readonly overlay: RestartOverlay;
  /** Remember what a restart did. */
  readonly record: (result: RestartResult) => void;
  /** Forget it: the marks go back to what the daemon says. */
  readonly clear: () => void;
}

const EMPTY: RestartOverlay = { restarted: new Set(), queued: new Set() };

const held = new WeakMap<object, RestartOverlay>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const write = (key: object, overlay: RestartOverlay): void => {
  if (overlay === EMPTY) held.delete(key);
  else held.set(key, overlay);
  for (const listener of [...listeners]) listener();
};

export const useRestartOverlay = (key: object | undefined): RestartOverlayControls => {
  const overlay = useSyncExternalStore(
    subscribe,
    () => (key === undefined ? EMPTY : (held.get(key) ?? EMPTY)),
    () => EMPTY,
  );
  const record = useCallback(
    (result: RestartResult) => {
      if (key === undefined) return;
      write(key, {
        restarted: new Set(result.restarted.map(entry => entry.id)),
        queued: new Set(result.queued.map(entry => entry.id)),
      });
    },
    [key],
  );
  const clear = useCallback(() => {
    if (key !== undefined) write(key, EMPTY);
  }, [key]);
  return { overlay, record, clear };
};

/** What the mark says for one ferret: the daemon's word, "Queued" once a restart is waiting, or nothing. */
type OutdatedState = 'outdated' | 'queued' | 'restarted';

export const outdatedState = (ferret: FerretSummary, overlay: RestartOverlay): OutdatedState =>
  overlay.restarted.has(ferret.id) ? 'restarted' : overlay.queued.has(ferret.id) ? 'queued' : 'outdated';
