/**
 * THE FERRET: Ferretry's mascot, one component, one file.
 *
 * It is an illustration, not the logo — the logomark stays the Fleet Grid (`BrandMark`) — but it is drawn from the
 * logo's own colour and in its flat, geometric manner. The mascot lives in a burrow and has three poses, set by `pose`
 * and styled in `app/styles.css` (`.fy-ferret`):
 *
 *   peek     — head just over the lip of the hole, blinking: somebody is waiting to be introduced.
 *   curious  — a little higher, head tilting and nose twitching: something is happening.
 *   cheer    — all the way up, a happy wiggle, one arm waving: it worked.
 *
 * SHAPE: a big round head on small shoulders. Only the head, the shoulders and the paws ever show: the body sits low in
 * the burrow, so there is no neck, and the paws rest on the lip of the hole. Big round eyes with a white highlight inside
 * a soft, lighter glow that fades out, a small pink nose, a tiny smile and light cheeks: friendly, not a bandit.
 *
 * ONE FILE ON PURPOSE: any screen that wants the mascot imports this and nothing else. The pose is the only prop that
 * changes the drawing; every motion is CSS (transform and opacity only) so it costs no script, stills under
 * reduced motion (the OS setting or the app's Motion = Reduced) and holds its FINAL picture then.
 *
 * REACTS: hovering it (a mouse) or tapping it (a phone) raises it out of the hole, tilts its head hello, wiggles its ears
 * and sniffs (`app/styles.css`, "the ferret answers a hover"); a cheering ferret is left alone.
 *
 * Decorative: `aria-hidden`. The words next to it carry the meaning, and a screen reader announcing "image, ferret" for
 * a flourish is noise.
 *
 * COLOUR: the Fleet Grid logo's own token, `--accent`, mixed toward white and black in `app/styles.css` (`.fy-ferret`),
 * so the ferret re-tints with the theme and reads on light and dark. There is no hand-picked hex.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { cn, useDocumentVisible } from '@ferretry/app/ui';

export type FerretPose = 'peek' | 'curious' | 'cheer';

export interface FerretMascotProps {
  readonly pose: FerretPose;
  readonly className?: string;
}

/** How long a tap keeps the ferret perked up. */
const POKE_MS = 1_400;

export function FerretMascot({ pose, className }: FerretMascotProps) {
  // Unique per instance: two mascots on one page must not share a clip path or a gradient.
  const id = `fy-ferret-${useId().replaceAll(':', '')}`;
  // A hidden tab keeps nothing running (the sky pauses the same way).
  const visible = useDocumentVisible();
  const cheering = pose === 'cheer';
  // A tap pokes the ferret for a moment (a phone has no hover); a mouse hover is pure CSS.
  const [poked, setPoked] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const poke = () => {
    clearTimeout(timer.current);
    setPoked(true);
    timer.current = setTimeout(() => setPoked(false), POKE_MS);
  };
  return (
    <svg
      className={cn('fy-ferret', className)}
      data-pose={pose}
      data-paused={visible ? undefined : ''}
      data-poke={poked ? '' : undefined}
      onClick={poke}
      viewBox="0 0 240 190"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={`${id}-clip`}>
          <rect x="0" y="-60" width="240" height="246" />
        </clipPath>
        {/* The soft glow around an eye: a lighter tint in the middle that fades to nothing at the edge. */}
        <radialGradient id={`${id}-glow`}>
          <stop offset="0" style={{ stopColor: 'var(--fy-ferret-glow)', stopOpacity: 1 }} />
          <stop offset="0.55" style={{ stopColor: 'var(--fy-ferret-glow)', stopOpacity: 0.55 }} />
          <stop offset="1" style={{ stopColor: 'var(--fy-ferret-glow)', stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <ellipse className="fy-ferret-halo" cx="120" cy="110" rx="104" ry="84" />
      <ellipse className="fy-ferret-hill" cx="120" cy="166" rx="112" ry="26" />
      <ellipse className="fy-ferret-hole" cx="120" cy="150" rx="34" ry="12" />

      <g clipPath={`url(#${id}-clip)`}>
        <g className="fy-ferret-body">
          {/* Shoulders only: a low dome, the head rests straight on it. */}
          <ellipse className="fy-ferret-fur" cx="120" cy="164" rx="46" ry="40" />
          <g className="fy-ferret-head">
            {/* Small rounded ears, low on the sides of a wide oval head. */}
            <g className="fy-ferret-ear-l">
              <ellipse className="fy-ferret-fur" cx="77" cy="84" rx="9" ry="10.5" />
              <ellipse className="fy-ferret-ear" cx="77" cy="85" rx="4.2" ry="5.6" />
            </g>
            <g className="fy-ferret-ear-r">
              <ellipse className="fy-ferret-fur" cx="163" cy="84" rx="9" ry="10.5" />
              <ellipse className="fy-ferret-ear" cx="163" cy="85" rx="4.2" ry="5.6" />
            </g>
            <ellipse className="fy-ferret-fur" cx="120" cy="102" rx="49" ry="32" />
            <ellipse className="fy-ferret-cream" cx="120" cy="116" rx="36" ry="21" />
            <ellipse fill={`url(#${id}-glow)`} cx="102" cy="99" rx="20" ry="17" />
            <ellipse fill={`url(#${id}-glow)`} cx="138" cy="99" rx="20" ry="17" />
            <g className="fy-ferret-eyes">
              {[102, 138].map(x => (
                <g key={x}>
                  <circle className="fy-ferret-eye" cx={x} cy="99" r="6.2" />
                  <circle className="fy-ferret-glint" cx={x + 2.2} cy="96.4" r="2.3" />
                  <circle className="fy-ferret-glint" cx={x - 2.2} cy="101.6" r="1" />
                </g>
              ))}
            </g>
            <ellipse className="fy-ferret-blush" cx="90" cy="113" rx="7.5" ry="4.6" />
            <ellipse className="fy-ferret-blush" cx="150" cy="113" rx="7.5" ry="4.6" />
            <ellipse className="fy-ferret-muzzle" cx="120" cy="119" rx="17" ry="11.5" />
            <ellipse className="fy-ferret-nose" cx="120" cy="113" rx="4.6" ry="3.3" />
            <path className="fy-ferret-mouth" d="M114.5 123 Q120 128 125.5 123" />
            <path
              className="fy-ferret-whiskers"
              d="M102 118 L84 115 M102 121 L83 123 M138 118 L156 115 M138 121 L157 123"
            />
          </g>
        </g>
        {/* The waving arm: it rises out of the hole beside the head. Hidden except when cheering. */}
        <g className="fy-ferret-wave">
          <rect className="fy-ferret-fur" x="156" y="112" width="13" height="52" rx="6.5" />
          <ellipse className="fy-ferret-paw" cx="162.5" cy="112" rx="10" ry="9" />
        </g>
      </g>

      {/* The lip of the hole sits in FRONT of the ferret, so it can sink behind it. */}
      <path className="fy-ferret-lip" d="M66 148 Q120 180 174 148 L174 186 L66 186 Z" />
      <path className="fy-ferret-lip-edge" d="M66 148 Q120 180 174 148" />
      {/* The paws rest on the edge of the burrow. When cheering one is up, waving, and the other pops into view. */}
      {cheering ? (
        <ellipse className="fy-ferret-paw fy-ferret-paw-rest" cx="93" cy="157" rx="12" ry="8.5" />
      ) : (
        <>
          <ellipse className="fy-ferret-paw" cx="94" cy="157" rx="12" ry="8.5" />
          <ellipse className="fy-ferret-paw" cx="146" cy="157" rx="12" ry="8.5" />
        </>
      )}
    </svg>
  );
}
