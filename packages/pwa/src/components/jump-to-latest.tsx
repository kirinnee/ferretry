import { ArrowDown } from 'lucide-react';
import { jumpToLatestLabel } from '../lib/transcript-follow.ts';

/**
 * The "↓ jump to latest" pill a detached reader gets back to the tail with.
 *
 * It gets a row of its own under the scroller, in its host's flex column (the scroller must be a `flex: 1`
 * sibling above it), so it takes its height from the scroller while it shows and can never cover what the
 * reader is looking at. In the chat that column ends at the composer, so the pill floats above it, not over it.
 */
export function JumpToLatest({ count = 0, onJump }: { readonly count?: number; readonly onJump: () => void }) {
  return (
    <div className="fy-jump-latest-shell">
      <button className="fy-jump-latest" onClick={onJump} type="button">
        <ArrowDown aria-hidden="true" size={13} />
        {jumpToLatestLabel(count)}
      </button>
    </div>
  );
}
