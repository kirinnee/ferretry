/**
 * THE "OUTDATED" MARK: a quiet word on a ferret that runs on older instructions than it would be launched
 * with today. It is a WORD, not a colour or a dot, so it reads the same in every theme and to a screen
 * reader; its tooltip and accessible name say which sections changed. Drawn on a sidebar row and in the
 * session header, and never as a control: the one button is "Restart outdated" (`restart-outdated-strip.tsx`).
 */
import type { SessionView } from '@ferretry/protocol';
import { isOutdated, outdatedLabel } from './outdated-model.ts';

export function OutdatedMark({ view }: { readonly view: SessionView }) {
  if (!isOutdated(view)) return null;
  const label = outdatedLabel(view);
  return (
    <span aria-label={label} className="fy-outdated-mark" data-outdated-mark="" role="img" title={label}>
      <span aria-hidden="true">Outdated</span>
    </span>
  );
}
