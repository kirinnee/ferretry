/**
 * THE FERRET: Ferretry's mascot, one component, one file.
 *
 * It is an illustration, not the logo — the logomark stays the Fleet Grid (`BrandMark`). The mascot lives in a burrow and
 * has three poses, set by `pose` and styled in `app/styles.css` (`.fy-ferret`):
 *
 *   peek     — head just over the lip of the hole, blinking: somebody is waiting to be introduced.
 *   curious  — a little higher, head tilting and nose twitching: something is happening.
 *   cheer    — all the way up, a happy wiggle, one arm waving: it worked.
 *
 * ONE FILE ON PURPOSE: any screen that wants the mascot imports this and nothing else. The pose is the only prop that
 * changes the drawing; every motion is CSS (transform and opacity only) so it costs no script, stills under
 * reduced motion (the OS setting or the app's Motion = Reduced) and holds its FINAL picture then.
 *
 * Decorative: `aria-hidden`. The words next to it carry the meaning, and a screen reader announcing "image, ferret" for
 * a flourish is noise.
 *
 * COLOUR: the sky, the hill and the accents come from the theme's own tokens; the fur is the mascot's own small palette
 * (`--fy-ferret-*` in `app/styles.css`), the only literal colours here, because no theme token is a ferret.
 */
import { useId } from 'react';
import { cn, useDocumentVisible } from '@ferretry/app/ui';

export type FerretPose = 'peek' | 'curious' | 'cheer';

export interface FerretMascotProps {
  readonly pose: FerretPose;
  readonly className?: string;
}

export function FerretMascot({ pose, className }: FerretMascotProps) {
  // Unique per instance: two mascots on one page must not share a clip path.
  const clip = `fy-ferret-clip-${useId().replaceAll(':', '')}`;
  // A hidden tab keeps nothing running (the sky pauses the same way).
  const visible = useDocumentVisible();
  return (
    <svg
      className={cn('fy-ferret', className)}
      data-pose={pose}
      data-paused={visible ? undefined : ''}
      viewBox="0 0 240 190"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clip}>
          <rect x="0" y="-60" width="240" height="246" />
        </clipPath>
      </defs>
      <ellipse className="fy-ferret-halo" cx="120" cy="110" rx="104" ry="84" />
      <ellipse className="fy-ferret-hill" cx="120" cy="166" rx="112" ry="26" />
      <ellipse className="fy-ferret-hole" cx="120" cy="148" rx="54" ry="16" />

      <g clipPath={`url(#${clip})`}>
        <g className="fy-ferret-body">
          <rect className="fy-ferret-fur" x="97" y="70" width="46" height="110" rx="22" />
          <g className="fy-ferret-head">
            <circle className="fy-ferret-fur" cx="88" cy="38" r="12" />
            <circle className="fy-ferret-fur" cx="152" cy="38" r="12" />
            <circle className="fy-ferret-ear" cx="88" cy="39" r="6" />
            <circle className="fy-ferret-ear" cx="152" cy="39" r="6" />
            <ellipse className="fy-ferret-fur" cx="120" cy="62" rx="38" ry="32" />
            <ellipse className="fy-ferret-cream" cx="120" cy="70" rx="27" ry="22" />
            <rect className="fy-ferret-mask" x="90" y="50" width="60" height="19" rx="9.5" />
            <g className="fy-ferret-eyes">
              <circle className="fy-ferret-eye" cx="106" cy="59.5" r="3.8" />
              <circle className="fy-ferret-eye" cx="134" cy="59.5" r="3.8" />
              <circle className="fy-ferret-glint" cx="107.2" cy="58.2" r="1.2" />
              <circle className="fy-ferret-glint" cx="135.2" cy="58.2" r="1.2" />
            </g>
            <ellipse className="fy-ferret-blush" cx="96" cy="76" rx="6" ry="4" />
            <ellipse className="fy-ferret-blush" cx="144" cy="76" rx="6" ry="4" />
            <ellipse className="fy-ferret-muzzle" cx="120" cy="77" rx="14" ry="10" />
            <ellipse className="fy-ferret-nose" cx="120" cy="71.5" rx="5" ry="3.6" />
            <path className="fy-ferret-mouth" d="M113.5 80 Q120 86.5 126.5 80" />
            <path
              className="fy-ferret-whiskers"
              d="M104 76 L84 72 M104 79 L83 80 M105 82 L86 88 M136 76 L156 72 M136 79 L157 80 M135 82 L154 88"
            />
          </g>
        </g>
        {/* The waving arm: it rises out of the hole beside the body. Hidden except when cheering. */}
        <g className="fy-ferret-wave">
          <rect className="fy-ferret-fur" x="143" y="112" width="12" height="52" rx="6" />
          <ellipse className="fy-ferret-paw" cx="149" cy="112" rx="9.5" ry="8.5" />
        </g>
      </g>

      {/* The lip of the hole sits in FRONT of the ferret, so it can sink behind it. */}
      <path className="fy-ferret-lip" d="M66 148 Q120 180 174 148 L174 186 L66 186 Z" />
      <path className="fy-ferret-lip-edge" d="M66 148 Q120 180 174 148" />
      <ellipse className="fy-ferret-paw fy-ferret-paw-rest" cx="94" cy="160" rx="12" ry="8.5" />
    </svg>
  );
}
