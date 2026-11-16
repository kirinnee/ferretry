/**
 * THE "OUTDATED" MARK: a small refresh glyph on a ferret that runs on older instructions than it would be launched with
 * today. It is an icon, not a word, so a row whose name is long never gives the name up to it; its tooltip and accessible
 * name carry the words and say which sections changed. It is never a control: the one action is "Restart outdated" in the
 * list's ⋯ menu (`restart-outdated-menu.tsx`).
 *
 * After a press the same place answers it: a ferret that restarted drops the mark, and one waiting for its next idle
 * moment reads "Queued" (`restart-overlay.ts`) in muted ink.
 */
import { Clock, RefreshCw } from 'lucide-react';
import type { FerretSummary } from '../../../contract/index.ts';
import { isOutdated, outdatedLabel } from './outdated-model.ts';
import { outdatedState, useRestartOverlay } from './restart-overlay.ts';

const QUEUED_LABEL = 'Queued: restarts at this ferret’s next idle moment, keeping its conversation.';

type OutdatedMarkState = 'outdated' | 'queued';

/** What the mark says about a ferret, or null when it says nothing (up to date, or already restarted). */
function useOutdatedMarkState(ferret: FerretSummary, overlayKey: object | undefined): OutdatedMarkState | null {
  const { overlay } = useRestartOverlay(overlayKey);
  if (!isOutdated(ferret)) return null;
  const state = outdatedState(ferret, overlay);
  if (state === 'restarted') return null;
  return state === 'queued' ? 'queued' : 'outdated';
}

/**
 * `overlayKey` is the daemon's client (see `restart-overlay.ts`): the list's rows and Info draw the same mark from the same answer.
 */
export function OutdatedMark({
  ferret,
  overlayKey,
}: {
  readonly ferret: FerretSummary;
  readonly overlayKey?: object | undefined;
}) {
  const state = useOutdatedMarkState(ferret, overlayKey);
  if (state === null) return null;
  const queued = state === 'queued';
  const label = queued ? QUEUED_LABEL : outdatedLabel(ferret);
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
