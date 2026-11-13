/**
 * The notice the Processes tab leaves behind after a stop: one short sentence, shown for a few seconds.
 *
 * The live region is ALWAYS mounted, empty when there is nothing to say, so a screen reader hears the sentence the
 * moment it arrives instead of missing a region that appeared with its text already in it. It dismisses itself, and a
 * ✕ dismisses it sooner.
 */

import { X } from 'lucide-react';
import { useEffect } from 'react';

const PROCESS_TOAST_MS = 6_000;

export function ProcessToast({
  notice,
  onDismiss,
  dismissMs = PROCESS_TOAST_MS,
}: {
  readonly notice: string | null;
  readonly onDismiss: () => void;
  readonly dismissMs?: number;
}) {
  useEffect(() => {
    if (notice === null) return;
    const timer = globalThis.setTimeout(onDismiss, dismissMs);
    return () => globalThis.clearTimeout(timer);
  }, [notice, onDismiss, dismissMs]);

  return (
    <div className={notice === null ? 'sr-only' : 'fy-proc-toast kt-panel'} data-action-toast="">
      <p className="fy-proc-toast__text" role="status">
        {notice ?? ''}
      </p>
      {notice === null ? null : (
        <button aria-label="Dismiss" className="fy-proc-toast__close" onClick={onDismiss} type="button">
          <X aria-hidden="true" size={14} />
        </button>
      )}
    </div>
  );
}
