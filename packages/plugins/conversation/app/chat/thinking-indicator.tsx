/**
 * Live transcript footer for an active turn.
 *
 * The daemon's activity line often embeds an elapsed value that arrives in
 * coarse snapshots. Keep its useful wording, discard that stale parenthetical,
 * and render a fluid elapsed value from the shared client clock instead.
 */

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
