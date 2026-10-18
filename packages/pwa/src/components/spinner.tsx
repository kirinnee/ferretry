/**
 * THE ONE BUSY MARK — an accent arc turning on a visible track.
 *
 * Every "something is happening" spinner the reader watches (the live activity line, a running tool,
 * Send while a message leaves, the Reconnecting pill, a harness install) is this one element, so a
 * theme restyles all of them in one place: `components/spinner.css` reads colour, stroke, cap, speed
 * and glow from `--spinner-*` tokens each theme family sets, light and dark alike.
 *
 * WHY A TRACK. A lone faint ring on a near-matching surface is the mark that disappeared: the arc is
 * the only part that moves, so it is the part held to 3:1 against its surface in every family and mode
 * (`harness/live-activity-screenshot.tsx` sweeps them), and the track stays visible so the reader sees
 * the shape even in the instant the arc is small.
 *
 * Reduced motion turns the spin into a pulse rather than stopping it — a frozen spinner reads as a
 * hung one. It is decoration: the words beside it carry the status, so it is hidden from assistive
 * technology.
 */

export interface SpinnerProps {
  /** Rendered size in CSS pixels; the stroke scales with it. */
  readonly size?: number;
  readonly className?: string;
}

export function Spinner({ size = 14, className }: SpinnerProps) {
  return (
    <svg
      aria-hidden="true"
      className={className === undefined ? 'fy-spinner' : `fy-spinner ${className}`}
      data-spinner=""
      focusable="false"
      height={size}
      viewBox="0 0 16 16"
      width={size}
    >
      <circle className="fy-spinner-track" cx="8" cy="8" fill="none" r="6" />
      <circle className="fy-spinner-arc" cx="8" cy="8" fill="none" pathLength="100" r="6" />
    </svg>
  );
}
