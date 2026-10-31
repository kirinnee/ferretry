import { ArrowDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import { jumpToLatestLabel } from '../lib/transcript-follow.ts';

/**
 * The "↓ jump to latest" pill a detached reader gets back to the tail with.
 *
 * It is drawn in the chat's agenda row, on its left (`host`, `AgendaLine`), or, with no row to share, in a row of
 * its own under the scroller, in its host's flex column (the scroller must be a `flex: 1` sibling above it). Either
 * way it takes its place from the scroller and can never cover what the reader is looking at, and in the chat that
 * column ends at the composer, so the pill floats above it, not over it.
 *
 * A row of its own exists only while the pill does, so a chat with nothing to show leaves NO band above the composer.
 * It used to be held at its height by an invisible twin so the scroller never changed size, but that was the band
 * the owner kept seeing (two rows of chrome, then one invisible one). The flicker the twin guarded against —
 * the row leaving at the bottom clamps `scrollTop`, which was read as the reader scrolling up — is guarded where it
 * is read now: `scrollVerdict` never calls a scroll that came with a change of the viewport's height a reader's.
 * The agenda row's host is a fixed height that does not depend on the pill, so it never resizes at all.
 */
export function JumpToLatest({
  count = 0,
  host = null,
  onJump,
  shown,
}: {
  readonly count?: number;
  readonly host?: HTMLElement | null;
  readonly onJump: () => void;
  readonly shown: boolean;
}) {
  const pill = shown ? (
    <button className="fy-jump-latest" data-jump-hosted={host === null ? undefined : ''} onClick={onJump} type="button">
      <ArrowDown aria-hidden="true" size={13} />
      {jumpToLatestLabel(count)}
    </button>
  ) : null;
  if (host !== null) return createPortal(pill, host);
  return pill === null ? null : <div className="fy-jump-latest-shell">{pill}</div>;
}
