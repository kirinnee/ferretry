import { ArrowDown } from 'lucide-react';
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
 */
export function JumpToLatest({
  count = 0,
  onJump,
  shown,
}: {
  readonly count?: number;
  readonly onJump: () => void;
  readonly shown: boolean;
}) {
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
