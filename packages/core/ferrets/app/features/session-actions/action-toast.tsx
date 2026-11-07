/**
 * The toast an Actions form leaves behind: one short sentence about something that will happen out of
 * sight ("Investigation of hadi queued — the report lands in Info › Signals"), shown for a few seconds
 * after the form has closed.
 *
 * The live region is ALWAYS mounted, empty when there is nothing to say, so a screen reader hears the
 * sentence the moment it arrives instead of missing a region that appeared with its text already in it.
 * It dismisses itself, and a ✕ dismisses it sooner.
 */

import { X } from 'lucide-react';
import { useEffect } from 'react';

export const ACTION_TOAST_MS = 6_000;

export function ActionToast({
  notice,
  onDismiss,
  dismissMs = ACTION_TOAST_MS,
}: {
  readonly notice: string | null;
  readonly onDismiss: () => void;
  readonly dismissMs?: number;
}) {
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(onDismiss, dismissMs);
    return () => clearTimeout(timer);
  }, [notice, onDismiss, dismissMs]);

  return (
    <div className={notice === null ? 'sr-only' : 'fy-action-toast kt-panel'} data-action-toast="">
      <p className="fy-action-toast__text" role="status">
        {notice ?? ''}
      </p>
      {notice === null ? null : (
        <button aria-label="Dismiss" className="fy-action-toast__close" onClick={onDismiss} type="button">
          <X aria-hidden="true" size={14} />
        </button>
      )}
    </div>
  );
}
