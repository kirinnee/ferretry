import { ArrowDown } from 'lucide-react';
import { jumpToLatestLabel } from '../lib/transcript-follow.ts';

/**
 * The "↓ jump to latest" pill a detached reader gets back to the tail with.
 *
 * It sits in a gradient strip rather than bare over the text, so neither it nor what is behind it is
 * hard to read. The strip is absolutely placed in its host's own box (which must be `position:
 * relative`), so in the chat it floats above the composer and never over it.
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
