/**
 * STATUS AS A SHAPE, NOT A COLOUR.
 *
 * (DUPLICATE TO CONSOLIDATE: Conversation C1 is adding the shared `statusMark` to `@ferretry/app`; this is the local
 * copy until it lands, kept to Ferrets' four states.)
 *
 * The header and a row have room for exactly one status glyph, and a coloured dot is the classic accessibility
 * failure. So the glyph carries THREE signals at once —
 *
 *   SHAPE   circle   the ferret is doing something right now
 *           diamond  it is parked, waiting on a human, a peer or a deadline
 *           square   it is over (finished, stopped)
 *   COLOUR  the existing ok / warn / err / pend tones, per theme, never the only difference between two states
 *   TEXT    an `aria-label` + `title` naming the class AND the state in words
 *
 * The shapes are markup rather than tokens on purpose; only the colours come from tokens.
 */

import { cn } from '../ui.ts';
import type { FerretState, FerretSummary } from '../../contract/index.ts';

type StatusShape = 'circle' | 'diamond' | 'square';
type StatusClass = 'active' | 'waiting' | 'finished';
type StatusTone = 'ok' | 'warn' | 'err' | 'pend' | 'accent';

/** The fields a mark is drawn from. */
export type MarkedFerret = Pick<FerretSummary, 'state'> & Partial<Pick<FerretSummary, 'waiting' | 'finishedAt'>>;

/** A ferret that is over: a stopped one can resume, but nothing is moving it now. */
export const isFerretOver = (state: FerretState): boolean => state === 'stopped';

export interface StatusMarkInfo {
  readonly shape: StatusShape;
  readonly klass: StatusClass;
  readonly tone: StatusTone;
  /** The full accessible string: "waiting — parked for freddie: CI". */
  readonly label: string;
  /** Whether the mark should breathe (live work only, motion-gated in CSS). */
  readonly live: boolean;
}

/** The state in words, for every surface that shows one. */
export const ferretStateLabel = (state: FerretState): string => state;

/** At its prompt: launched, nothing asked of it yet, or its last turn over. Calm `ok`, a diamond, parked on the person. */
const YOUR_TURN_MARK: StatusMarkInfo = Object.freeze({
  shape: 'diamond',
  klass: 'waiting',
  tone: 'ok',
  label: 'waiting — your turn',
  live: false,
});

export function statusMark(ferret: MarkedFerret): StatusMarkInfo {
  const { state } = ferret;
  if (isFerretOver(state)) {
    const ok = ferret.finishedAt !== undefined;
    return {
      shape: 'square',
      klass: 'finished',
      tone: ok ? 'ok' : 'err',
      label: `finished — ${ok ? 'done' : 'stopped'}`,
      live: false,
    };
  }
  // A DECLARED park is healthy and names its condition.
  const wait = ferret.waiting;
  if (wait !== undefined) {
    return {
      shape: 'diamond',
      klass: 'waiting',
      tone: 'warn',
      label: `waiting — parked${wait.peerName ? ` for ${wait.peerName}` : ''}${wait.condition ? `: ${wait.condition}` : ''}`,
      live: false,
    };
  }
  if (state === 'idle') return YOUR_TURN_MARK;
  return { shape: 'circle', klass: 'active', tone: 'warn', label: `active — ${ferretStateLabel(state)}`, live: true };
}

/**
 * How a ROW carrying this ferret should treat its name. A finished ferret is over, so its name recedes to `--muted`;
 * live and waiting work stays at full `--fg` strength. A lightness step, never a hue, so it reads in greyscale.
 */
export function nameToneClass(ferret: MarkedFerret): string {
  return statusMark(ferret).klass === 'finished' ? 'text-muted' : 'text-fg';
}

const TONE_FILL: Record<StatusTone, string> = {
  ok: 'bg-ok border-ok-border',
  warn: 'bg-warn border-warn-border',
  err: 'bg-err border-err-border',
  pend: 'bg-pend border-pend-border',
  accent: 'bg-accent border-accent-border',
};

const SHAPE_CLASS: Record<StatusShape, string> = {
  circle: 'rounded-full',
  // A rotated square reads as a diamond at 8px where an SVG path would not.
  // theme-literal-ok: the 1px corner is part of the mark's shape, a non-colour signal that must not follow the theme
  diamond: 'rotate-45 rounded-[1px]',
  // theme-literal-ok: a 1px corner is part of the square mark's shape, a non-colour signal that must not follow the theme
  square: 'rounded-[1px]',
};

export interface StatusMarkProps {
  readonly ferret: MarkedFerret;
  readonly size?: number;
  readonly className?: string;
}

/** The glyph. `role="img"` + `aria-label` so it is announced as one thing, and `title` so hover has the same words. */
export function StatusMark({ ferret, size = 8, className = '' }: StatusMarkProps) {
  const info = statusMark(ferret);
  return (
    <span
      role="img"
      aria-label={info.label}
      title={info.label}
      // The wrapper keeps a stable, unrotated box so a diamond does not change the row's metrics relative to a circle.
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size + 4, height: size + 4 }}
    >
      <span
        aria-hidden
        className={cn('block border', SHAPE_CLASS[info.shape], TONE_FILL[info.tone], info.live && 'kt-pulse')}
        style={{ width: size, height: size }}
      />
    </span>
  );
}
