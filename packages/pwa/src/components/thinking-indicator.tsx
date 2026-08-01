/**
 * Live transcript footer for an active turn.
 *
 * The daemon's activity line often embeds an elapsed value that arrives in
 * coarse snapshots. Keep its useful wording, discard that stale parenthetical,
 * and render a fluid elapsed value from the shared client clock instead.
 */

import { useLiveClock } from '../hooks/use-live-clock.ts';

/** Human-scale elapsed time for the live-turn footer. */
export const formatThinkingElapsed = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

/** Remove the daemon's quantised elapsed suffix while retaining its activity. */
export const thinkingActivityLabel = (activity?: string | null): string => {
  const raw = activity?.trim() || 'Working…';
  return raw.replace(/\s*\([^)]*\)\s*$/u, '').trim() || 'Working…';
};

export interface ThinkingIndicatorProps {
  readonly activity?: string | null;
  /** Milliseconds since this turn began. */
  readonly since?: number | null;
}

/** A compact, motion-reduced-safe indication that the selected session is live. */
export const ThinkingIndicator = ({ activity, since }: ThinkingIndicatorProps) => {
  // Render from the shared tick rather than calling Date.now during render. A
  // store update with no clock tick then produces identical text, preserving a
  // reader's transcript selection instead of rewriting it unnecessarily.
  const now = useLiveClock();
  const elapsed = since === null || since === undefined ? null : formatThinkingElapsed(now - since);

  return (
    <div className="flex items-center gap-2 text-[12.5px]" role="status">
      <span aria-hidden="true" className="flex gap-0.5">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: '0ms' }} />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: '120ms' }} />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: '240ms' }} />
      </span>
      <span className="mono shimmer">{thinkingActivityLabel(activity)}</span>
      {elapsed === null ? null : <span className="mono text-faint">{elapsed}</span>}
    </div>
  );
};
