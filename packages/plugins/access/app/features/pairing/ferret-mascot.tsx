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
 * SHAPE: only the head, the shoulders and the paws ever show. The body sits low in the burrow, so there is no neck to
 * speak of: the head rests right on the shoulders and the lip of the hole hides the rest.
 *
 * ONE FILE ON PURPOSE: any screen that wants the mascot imports this and nothing else. The pose is the only prop that
 * changes the drawing; every motion is CSS (transform and opacity only) so it costs no script, stills under
 * reduced motion (the OS setting or the app's Motion = Reduced) and holds its FINAL picture then.
 *
 * Decorative: `aria-hidden`. The words next to it carry the meaning, and a screen reader announcing "image, ferret" for
 * a flourish is noise.
 *
 * COLOUR: every colour is the Fleet Grid logo's own token, `--accent` (the hub of the mark, indigo in light and a
 * lighter periwinkle in dark), mixed toward white for the face, belly and ears and toward black for the mask, nose
 * and burrow. There is not one hand-picked hex, so the ferret re-tints with the theme and reads on light and dark.
 */
import { useId, type CSSProperties } from 'react';
import { cn, useDocumentVisible } from '@ferretry/app/ui';

export type FerretPose = 'peek' | 'curious' | 'cheer';
/** `a` is the hooded ferret (round, one dark mask band); `b` is the geometric one (rounded squares, two eye patches). */
export type FerretLook = 'a' | 'b';

export interface FerretMascotProps {
  readonly pose: FerretPose;
  readonly className?: string;
  readonly look?: FerretLook;
}

const DEFAULT_LOOK: FerretLook = 'a';

/** The logo's hub colour, and its tints and shades: the only colour source in the drawing. */
const ink = 'var(--accent)';
const tint = (percent: number): string => `color-mix(in srgb, ${ink} ${percent}%, white)`;
const shade = (percent: number): string => `color-mix(in srgb, ${ink} ${percent}%, black)`;

const palette = (look: FerretLook): CSSProperties =>
  ({
    '--fy-ferret-fur': ink,
    '--fy-ferret-body': look === 'b' ? shade(72) : ink,
    '--fy-ferret-cream': tint(30),
    '--fy-ferret-cream-light': tint(16),
    '--fy-ferret-mask': shade(42),
    '--fy-ferret-ear': tint(48),
    '--fy-ferret-nose': shade(30),
    '--fy-ferret-eye': shade(24),
    '--fy-ferret-blush': tint(70),
    '--fy-ferret-hole': shade(24),
  }) as CSSProperties;

const bodyFill = { fill: 'var(--fy-ferret-body)' } satisfies CSSProperties;

export function FerretMascot({ pose, className, look = DEFAULT_LOOK }: FerretMascotProps) {
  // Unique per instance: two mascots on one page must not share a clip path.
  const clip = `fy-ferret-clip-${useId().replaceAll(':', '')}`;
  // A hidden tab keeps nothing running (the sky pauses the same way).
  const visible = useDocumentVisible();
  const cheering = pose === 'cheer';
  return (
    <svg
      className={cn('fy-ferret', className)}
      data-pose={pose}
      data-look={look}
      data-paused={visible ? undefined : ''}
      style={palette(look)}
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
      <ellipse className="fy-ferret-hole" cx="120" cy="150" rx="44" ry="14" />

      <g clipPath={`url(#${clip})`}>
        <g className="fy-ferret-body">
          {look === 'a' ? <HoodedBody /> : <GeometricBody />}
          <g className="fy-ferret-head">{look === 'a' ? <HoodedHead /> : <GeometricHead />}</g>
        </g>
        {/* The waving arm: it rises out of the hole beside the head. Hidden except when cheering. */}
        <g className="fy-ferret-wave">
          <rect className="fy-ferret-fur" x="154" y="112" width="13" height="52" rx="6.5" />
          <ellipse className="fy-ferret-paw" cx="160.5" cy="112" rx="10" ry="9" />
        </g>
      </g>

      {/* The lip of the hole sits in FRONT of the ferret, so it can sink behind it. */}
      <path className="fy-ferret-lip" d="M66 148 Q120 180 174 148 L174 186 L66 186 Z" />
      <path className="fy-ferret-lip-edge" d="M66 148 Q120 180 174 148" />
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

/** Shoulders only: a wide low dome, the head rests straight on it. */
function HoodedBody() {
  return <ellipse className="fy-ferret-fur" cx="120" cy="160" rx="55" ry="36" />;
}

function GeometricBody() {
  return <rect style={bodyFill} x="72" y="126" width="96" height="76" rx="34" />;
}

/** Wide oval head, small low ears, one dark mask band, a pale forehead blaze, pale chin and a long pale muzzle. */
function HoodedHead() {
  return (
    <>
      <ellipse className="fy-ferret-fur" cx="80" cy="82" rx="9" ry="10" />
      <ellipse className="fy-ferret-fur" cx="160" cy="82" rx="9" ry="10" />
      <ellipse className="fy-ferret-ear" cx="80" cy="83" rx="4" ry="5" />
      <ellipse className="fy-ferret-ear" cx="160" cy="83" rx="4" ry="5" />
      <ellipse className="fy-ferret-fur" cx="120" cy="101" rx="45" ry="32" />
      <ellipse className="fy-ferret-cream" cx="120" cy="113" rx="31" ry="21" />
      <ellipse className="fy-ferret-cream" cx="120" cy="83" rx="11" ry="7" />
      <rect className="fy-ferret-mask" x="90" y="88" width="60" height="19" rx="9.5" />
      <Eyes y={96.5} dx={15} />
      <ellipse className="fy-ferret-blush" cx="93" cy="115" rx="6" ry="4" />
      <ellipse className="fy-ferret-blush" cx="147" cy="115" rx="6" ry="4" />
      <ellipse className="fy-ferret-muzzle" cx="120" cy="117" rx="15" ry="10.5" />
      <ellipse className="fy-ferret-nose" cx="120" cy="110" rx="5.5" ry="3.8" />
      <path className="fy-ferret-mouth" d="M114 121 Q120 127 126 121" />
      <Whiskers y={113} />
    </>
  );
}

/** Rounded-square head and ears (the logo's cells), two separate eye patches, a pale lower face. */
function GeometricHead() {
  return (
    <>
      <rect className="fy-ferret-fur" x="80" y="62" width="24" height="24" rx="8" />
      <rect className="fy-ferret-fur" x="136" y="62" width="24" height="24" rx="8" />
      <rect className="fy-ferret-ear" x="86" y="68" width="12" height="12" rx="4" />
      <rect className="fy-ferret-ear" x="142" y="68" width="12" height="12" rx="4" />
      <rect className="fy-ferret-fur" x="78" y="70" width="84" height="66" rx="28" />
      <rect className="fy-ferret-cream" x="90" y="102" width="60" height="32" rx="16" />
      <rect className="fy-ferret-mask" x="88" y="84" width="27" height="22" rx="10" />
      <rect className="fy-ferret-mask" x="125" y="84" width="27" height="22" rx="10" />
      <Eyes y={95} dx={14.5} />
      <rect className="fy-ferret-muzzle" x="107" y="108" width="26" height="19" rx="9.5" />
      <rect className="fy-ferret-nose" x="115" y="108" width="10" height="7" rx="3.5" />
      <path className="fy-ferret-mouth" d="M115 120 Q120 125 125 120" />
      <Whiskers y={116} />
    </>
  );
}

/** Round white eyes with a dark pupil and a glint: they stay legible on the dark mask. */
function Eyes({ y, dx }: { readonly y: number; readonly dx: number }) {
  return (
    <g className="fy-ferret-eyes">
      <circle className="fy-ferret-glint" cx={120 - dx} cy={y} r="5.2" />
      <circle className="fy-ferret-glint" cx={120 + dx} cy={y} r="5.2" />
      <circle className="fy-ferret-eye" cx={120 - dx + 0.4} cy={y + 0.4} r="3.4" />
      <circle className="fy-ferret-eye" cx={120 + dx + 0.4} cy={y + 0.4} r="3.4" />
      <circle className="fy-ferret-glint" cx={120 - dx + 1.5} cy={y - 0.9} r="1.1" />
      <circle className="fy-ferret-glint" cx={120 + dx + 1.5} cy={y - 0.9} r="1.1" />
    </g>
  );
}

function Whiskers({ y }: { readonly y: number }) {
  const d = [
    `M104 ${y} L84 ${y - 4}`,
    `M104 ${y + 3} L83 ${y + 4}`,
    `M136 ${y} L156 ${y - 4}`,
    `M136 ${y + 3} L157 ${y + 4}`,
  ].join(' ');
  return <path className="fy-ferret-whiskers" d={d} />;
}
