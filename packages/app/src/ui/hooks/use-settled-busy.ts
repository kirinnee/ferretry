import { useEffect, useState } from 'react';

/** A busy flip must last this long before the pane shows it, so a blip of work never flashes a label. */
const BUSY_SHOW_AFTER_MS = 300;
/** Once shown, the busy cue stays this long after the work stops, so back-to-back work reads as one run. */
const BUSY_HIDE_AFTER_MS = 800;

/**
 * The busy flag a person sees: it rises only after `showAfterMs` of continuous work and falls only
 * after `hideAfterMs` of continuous idleness. The first value is taken as is — nothing has flipped yet.
 */
export function useSettledBusy(
  busy: boolean,
  showAfterMs: number = BUSY_SHOW_AFTER_MS,
  hideAfterMs: number = BUSY_HIDE_AFTER_MS,
): boolean {
  const [shown, setShown] = useState(busy);
  useEffect(() => {
    if (busy === shown) return;
    const timer = setTimeout(() => setShown(busy), busy ? showAfterMs : hideAfterMs);
    return () => clearTimeout(timer);
  }, [busy, shown, showAfterMs, hideAfterMs]);
  return shown;
}
