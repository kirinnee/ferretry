import { ArrowDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import { jumpToLatestLabel } from '../lib/transcript-follow.ts';

/**
 * The "↓ jump to latest" pill a detached reader gets back to the tail with.
 *
 * It gets a row of its own under the scroller, in its host's flex column (the scroller must be a `flex: 1`
 * sibling above it), so it takes its height from the scroller and can never cover what the reader is looking
 * at. In the chat that column ends at the composer, so the pill floats above it, not over it.
 *
 * THE ROW IS THERE WHETHER OR NOT THE PILL IS. A row that came and went resized the scroller, and the browser
 * clamped `scrollTop` to the new maximum — a scroll the follow model reads as the reader moving up, which
 * detached them and showed the pill again: a flicker loop on every approach to the bottom. While the pill is
 * hidden an invisible twin holds the same box, so the scroller's size never depends on it.
 *
 * WITH A HOST (the chat's agenda row, `AgendaLine`) the pill is drawn INSIDE that row, on its left, and the transcript
 * keeps no row of its own: the chat had two rows of chrome under the messages (an invisible one for this pill, the
 * agenda's below it), a band of nothing. The host row has a fixed height that does not depend on the pill, so the
 * scroller's size still never depends on it — the guarantee above holds by construction. Without one (no agenda
 * row to share) the row of its own is kept.
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
  if (host !== null)
    return createPortal(
      shown ? (
        <button className="fy-jump-latest" data-jump-hosted="" onClick={onJump} type="button">
          <ArrowDown aria-hidden="true" size={13} />
          {jumpToLatestLabel(count)}
        </button>
      ) : null,
      host,
    );
  return (
    <div className="fy-jump-latest-shell">
      {shown ? (
        <button className="fy-jump-latest" onClick={onJump} type="button">
          <ArrowDown aria-hidden="true" size={13} />
          {jumpToLatestLabel(count)}
        </button>
      ) : (
        <span aria-hidden="true" className="fy-jump-latest-reserve">
          <ArrowDown size={13} />
          &#8203;
        </span>
      )}
    </div>
  );
}
