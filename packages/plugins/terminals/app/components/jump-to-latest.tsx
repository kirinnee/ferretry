import { ArrowDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import { jumpToLatestLabel } from '../lib/follow-tail.ts';

/**
 * The "↓ jump to latest" pill a detached reader gets back to the tail with.
 *
 * It is drawn in a row of its own under the scroller (or, given a `host`, portalled into it), in its host's flex
 * column, so it takes its place from the scroller and can never cover what the reader is looking at. A row exists
 * only while the pill does, so a pane with nothing to show leaves no band. A private copy of the Chat transcript's
 * pill until the shared one lands in `@ferretry/app/ui`; its two rules are in `web-terminals.css`.
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
