/**
 * THE "OUTDATED" MARK: a quiet word on a ferret that runs on older instructions than it would be launched
 * with today. It is a WORD, not a colour or a dot, so it reads the same in every theme and to a screen
 * reader; its tooltip and accessible name say which sections changed. Drawn on a sidebar row and in the
 * session header, and never as a control: the one button is "Restart outdated" (`restart-outdated-strip.tsx`).
 *
 * After a press the same place answers it: a ferret that restarted drops the mark, and one waiting for its
 * next idle moment reads "Queued" (`restart-overlay.tsx`).
 */
import type { SessionView } from '@ferretry/protocol';
import { isOutdated, outdatedLabel } from './outdated-model.ts';
import { outdatedState, useRestartOverlay } from './restart-overlay.tsx';

const QUEUED_LABEL = 'Queued: restarts at this ferret’s next idle moment, keeping its conversation.';

export function OutdatedMark({ view }: { readonly view: SessionView }) {
  const { overlay } = useRestartOverlay();
  if (!isOutdated(view)) return null;
  const state = outdatedState(view, overlay);
  if (state === 'restarted') return null;
  const queued = state === 'queued';
  const label = queued ? QUEUED_LABEL : outdatedLabel(view);
  return (
    <span
      aria-label={label}
      className={queued ? 'fy-outdated-mark fy-outdated-mark--queued' : 'fy-outdated-mark'}
      data-outdated-mark={queued ? 'queued' : ''}
      role="img"
      title={label}
    >
      <span aria-hidden="true">{queued ? 'Queued' : 'Outdated'}</span>
    </span>
  );
}
