/**
 * The Reload control and the notices that say whether what is on screen is the
 * newest — the ONE presentation of `useFsResource`'s one decision.
 *
 * Its own module because both directions need it: `files-views.tsx` (through
 * the two file surfaces) and `rich-file-preview.tsx`, which `files-views.tsx`
 * already imports. Putting it in either of those would make them import each
 * other, and a cycle between a renderer and the thing it renders is a worse
 * answer than a small shared file.
 */

import { ChevronDown, Loader2, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';

export interface ReloadActionProps {
  /** What is being re-read, for the accessible name. */
  what: string;
  busy: boolean;
  onReload: () => void;
}

/**
 * The network reread, WORDED. Handover #37 asks for a visible Reload on the open
 * file, so this is a labelled control rather than a bare arrow whose meaning
 * lives in a tooltip — and it is never disabled, because a reader who presses it
 * again during a slow read is asking for the newest bytes, not making a mistake.
 *
 * The accessible name keeps the visible word (WCAG 2.5.3) and adds the target;
 * the in-flight state is carried by `aria-busy` and by the one live notice
 * below the bar, so it is announced once rather than by every control that
 * knows about it.
 */
export const ReloadAction = ({ what, busy, onReload }: ReloadActionProps) => (
  <button
    type="button"
    className="kt-fs-reload"
    data-busy={busy || undefined}
    aria-busy={busy}
    aria-label={`Reload ${what}`}
    title={`Re-read ${what} from the session host`}
    onClick={onReload}
  >
    <RefreshCw size={14} className={busy ? 'animate-spin' : undefined} aria-hidden="true" />
    <span>Reload</span>
  </button>
);

/** Just enough of an `FsResource` to say whether what is on screen is the newest. */
export interface ReloadStatus {
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly error: string | null;
}

/**
 * REFRESHING WINS OVER ERROR, because an attempt in flight is the newer fact.
 * The resource clears the error when the reread starts, so these two can never
 * both be true — this is the same decision read twice, not two of them.
 */
const reloadWording = (what: string, status: ReloadStatus): { progress: string; failure: string } => ({
  progress: status.refreshing ? `Reloading ${what} — showing the copy loaded earlier.` : '',
  // `stale` is the gate that keeps this off a surface with nothing retained:
  // there, the failure IS the whole answer and `Failed` states it with a retry.
  failure: !status.refreshing && status.stale && status.error !== null ? status.error : '',
});

/**
 * THE MESSAGE IS THE CONTROL. Two lines by default; one tap on the line shows
 * the rest. A phone has no hover, so a clamp that only a `title` could undo
 * leaves a sighted touch reader with a sentence that stops at the file name —
 * the whole text has to be reachable by pointing at it, not only by listening.
 *
 * No `aria-label`: the button's accessible name must stay the message itself,
 * because that name is what the alert around it announces.
 */
const StaleMessage = ({ text }: { text: string }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className="kt-fs-stale-text"
      data-expanded={expanded || undefined}
      aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}
    >
      <span>{text}</span>
      <ChevronDown className="kt-fs-stale-chevron" size={13} aria-hidden="true" />
    </button>
  );
};

export interface StaleNoticeProps {
  what: string;
  status: ReloadStatus;
  onRetry: () => void;
  /** A preview sits inside a small document; only the surfaces offer a dismiss. */
  dismissible?: boolean;
}

/**
 * The honest sentence for content that is still on screen but no longer known to
 * be current. On the file surfaces it sits OUTSIDE the scroller on purpose: the
 * reading position is part of what a reload must preserve, and a note pushed in
 * above the content would move it.
 *
 * TWO REGIONS, BOTH ALWAYS MOUNTED, BOTH INITIALLY EMPTY. A live region that is
 * inserted into the document with its text already inside it is the case screen
 * readers miss — `role="status"` especially — so the polite region and the
 * assertive one are present from the first render and only their text changes.
 * Empty, they collapse to nothing (`files.css` zeroes an `:empty` notice) while
 * staying in the accessibility tree, which is exactly what makes the change
 * announceable.
 *
 * The failure can be dismissed on a surface, because there it costs a fifth of a
 * phone's reading area on the pane whose whole point is preserving what you were
 * reading, and only a successful reload would otherwise remove it. A dismissal
 * answers ONE attempt: the next reread re-arms it, so a failure that recurs is
 * said again rather than silently swallowed.
 */
export const StaleNotice = ({ what, status, onRetry, dismissible = false }: StaleNoticeProps) => {
  const [dismissed, setDismissed] = useState(false);
  const refreshing = status.refreshing;
  useEffect(() => {
    if (refreshing) setDismissed(false);
  }, [refreshing]);

  const { progress, failure } = reloadWording(what, status);
  const shown = dismissed ? '' : failure;
  return (
    <>
      <div className="kt-fs-stale" role="status">
        {progress !== '' && (
          <>
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            <span>{progress}</span>
          </>
        )}
      </div>
      <div className="kt-fs-stale" data-tone="err" role="alert">
        {shown !== '' && (
          <>
            <StaleMessage text={`Could not reload ${what}: ${shown}. Showing the copy loaded earlier.`} />
            <button type="button" className="kt-btn kt-btn--sm kt-fs-retry" onClick={onRetry}>
              <RefreshCw size={13} aria-hidden="true" />
              Try again
            </button>
            {dismissible && (
              <button
                type="button"
                className="kt-fs-icon-button kt-fs-stale-dismiss"
                onClick={() => setDismissed(true)}
                aria-label={`Dismiss the failed reload of ${what}`}
                title="Dismiss"
              >
                <X size={15} aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
};
