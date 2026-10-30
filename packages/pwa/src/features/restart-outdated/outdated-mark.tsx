/**
 * THE "OUTDATED" MARK: a small refresh glyph on a ferret that runs on older instructions than it would be
 * launched with today. It is an icon, not a word, so a row whose name is long never gives the name up to it;
 * its tooltip and accessible name carry the words and say which sections changed. Drawn on a sidebar row (with
 * the mode icons) and in the session header, and never as a control: the one action is "Restart outdated" in the sessions bar's ⋯ menu
 * (`restart-outdated-strip.tsx`).
 *
 * After a press the same place answers it: a ferret that restarted drops the mark, and one waiting for its
 * next idle moment reads "Queued" (`restart-overlay.tsx`) in muted ink.
 */
import type { SessionView } from '@ferretry/protocol';
import { Clock, RefreshCw } from 'lucide-react';
import { isOutdated, outdatedLabel } from './outdated-model.ts';
import { outdatedState, useRestartOverlay } from './restart-overlay.tsx';

const QUEUED_LABEL = 'Queued: restarts at this ferret’s next idle moment, keeping its conversation.';

export type OutdatedMarkState = 'outdated' | 'queued';

/** What the mark says about a ferret, or null when it says nothing (up to date, or already restarted). */
export function useOutdatedMarkState(view: SessionView): OutdatedMarkState | null {
  const { overlay } = useRestartOverlay();
  if (!isOutdated(view)) return null;
  const state = outdatedState(view, overlay);
  if (state === 'restarted') return null;
  return state === 'queued' ? 'queued' : 'outdated';
}

/** The glyph for a state `useOutdatedMarkState` returned. */
export function OutdatedGlyph({ state, view }: { readonly state: OutdatedMarkState; readonly view: SessionView }) {
  const queued = state === 'queued';
  const label = queued ? QUEUED_LABEL : outdatedLabel(view);
  const Icon = queued ? Clock : RefreshCw;
  return (
    <span
      aria-label={label}
      className={queued ? 'fy-outdated-mark fy-outdated-mark--queued' : 'fy-outdated-mark'}
      data-outdated-mark={queued ? 'queued' : ''}
      role="img"
      title={label}
    >
      <Icon aria-hidden="true" size={13} />
    </span>
  );
}

export function OutdatedMark({ view }: { readonly view: SessionView }) {
  const state = useOutdatedMarkState(view);
  return state === null ? null : <OutdatedGlyph state={state} view={view} />;
}
