/**
 * STATUS AS A SHAPE, NOT A COLOUR.
 *
 * Ported from kteam `ui/src/components/StatusMark.tsx`, silhouettes intact.
 *
 * The sidebar row has room for exactly one status glyph, and a coloured dot is
 * the classic accessibility failure: ~8% of men cannot separate the green one
 * from the amber one, and nobody can hear either. So the glyph carries THREE
 * signals at once —
 *
 *   SHAPE   circle   the session is doing something right now
 *           diamond  it is parked, waiting on a human, a peer or a deadline
 *           square   it is over (completed, failed, stalled, stopped)
 *   COLOUR  the existing ok / warn / err / pend tones, per theme, never the
 *           only difference between two states
 *   TEXT    an `aria-label` + `title` naming the class AND the status in
 *           words, so a screen reader says "waiting — awaiting user" and a
 *           mouse user gets the same string on hover
 *
 * The shapes are markup rather than tokens on purpose (a theme may not redefine
 * "waiting is a diamond" — the convention has to hold across all of them); only
 * the colours come from tokens.
 */

import type { SessionStatus, SessionView } from '@ferretry/protocol';
import { cn } from '../lib/class-names.ts';
import { sessionStatusLabel } from '../lib/session-screens.ts';

/**
 * Wider than `isTerminalSessionStatus` in `lib/session-screens.ts` on purpose:
 * that one answers "did this session finish its work", which `stalled` and
 * `kill_failed` did not. This one answers "is this session over", and both of
 * those are — the glyph must not keep breathing for a session nothing will move
 * again.
 */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'completed',
  'failed',
  'stalled',
  'stopped',
  'kill_failed',
]);

/** Statuses that are parked on something external, declared wait or not. */
export const WAITING_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'waiting',
  'awaiting_user',
  'awaiting_question',
  'interrupted',
  'rate_limited',
]);

export type StatusShape = 'circle' | 'diamond' | 'square';
export type StatusClass = 'active' | 'waiting' | 'finished';
export type StatusTone = 'ok' | 'warn' | 'err' | 'pend' | 'accent';

export interface StatusMarkInfo {
  readonly shape: StatusShape;
  readonly klass: StatusClass;
  readonly tone: StatusTone;
  /** The full accessible string: "waiting — parked for freddie: CI". */
  readonly label: string;
  /** Whether the mark should breathe (live work only, motion-gated in CSS). */
  readonly live: boolean;
}

export function statusMark(view: SessionView): StatusMarkInfo {
  const status = view.state.status;
  const parked = !!view.state.waiting;
  // WHOSE TURN, when the daemon's turn watcher says. A live session at its prompt is waiting on the
  // person — so it is drawn and filed as waiting — and one blocked on a permission prompt is a
  // request for a human, exactly as an unanswered question is. Only a working one breathes.
  const turn = TERMINAL_STATUSES.has(status) || parked ? undefined : view.state.turnState;
  if (turn === 'your-turn') return YOUR_TURN_MARK;
  if (turn === 'needs-input') {
    if (view.state.permissionRequest !== undefined) return NEEDS_APPROVAL_MARK;
    return view.state.harnessDialog === undefined ? NEEDS_INPUT_MARK : NEEDS_DIALOG_MARK;
  }

  if (TERMINAL_STATUSES.has(status)) {
    const ok = status === 'completed';
    return {
      shape: 'square',
      klass: 'finished',
      tone: ok ? 'ok' : 'err',
      label: `finished — ${sessionStatusLabel(status)}`,
      live: false,
    };
  }

  if (parked || WAITING_STATUSES.has(status)) {
    // A DECLARED park is healthy and names its condition; an unanswered question
    // is a request for a human. Both are "waiting" in shape, and the label is
    // what tells them apart.
    const wait = view.state.waiting;
    const detail = wait
      ? `parked${wait.peerName ? ` for ${wait.peerName}` : ''}${wait.condition ? `: ${wait.condition}` : ''}`
      : sessionStatusLabel(status);
    return {
      shape: 'diamond',
      klass: 'waiting',
      tone: status === 'awaiting_question' || status === 'awaiting_user' ? 'accent' : 'warn',
      label: `waiting — ${detail}`,
      live: false,
    };
  }

  return {
    shape: 'circle',
    klass: 'active',
    tone: 'warn',
    label: `active — ${sessionStatusLabel(status)}`,
    live: true,
  };
}

/**
 * A LIVE session sitting at its prompt — launched, nothing asked of it yet, or
 * its last turn over. Still a circle, because it is live, but it does not
 * breathe and its tone is `ok`: nothing is happening, and nothing is wrong.
 * Only a surface that has the pane's evidence (`lib/session-activity.ts`) may
 * claim it; the daemon's own `running` cannot tell the two apart.
 */
export const READY_MARK: StatusMarkInfo = Object.freeze({
  shape: 'circle',
  klass: 'active',
  tone: 'ok',
  label: 'ready — at its prompt',
  live: false,
});

/** The daemon says it is the person's turn: parked on them, so a diamond, in the calm `ok` tone. */
export const YOUR_TURN_MARK: StatusMarkInfo = Object.freeze({
  shape: 'diamond',
  klass: 'waiting',
  tone: 'ok',
  label: 'waiting — your turn',
  live: false,
});

/** Blocked on a person — a permission prompt or a question — in the same accent a question uses. */
export const NEEDS_INPUT_MARK: StatusMarkInfo = Object.freeze({
  shape: 'diamond',
  klass: 'waiting',
  tone: 'accent',
  label: 'waiting — needs your input',
  live: false,
});

/** Blocked on a harness's own dialog (hooks to review, a sign-in): named for what it needs, drawn like any needs-input. */
export const NEEDS_DIALOG_MARK: StatusMarkInfo = Object.freeze({
  shape: 'diamond',
  klass: 'waiting',
  tone: 'accent',
  label: 'waiting — needs you at a dialog',
  live: false,
});

/** Blocked on a tool-permission prompt: the same mark as any other needs-input, named for what it needs. */
export const NEEDS_APPROVAL_MARK: StatusMarkInfo = Object.freeze({
  shape: 'diamond',
  klass: 'waiting',
  tone: 'accent',
  label: 'waiting — needs approval',
  live: false,
});

/**
 * How a ROW carrying this session should treat its name, so a dense list has
 * vertical variation without re-adding any fact. A finished session is over, so
 * its name recedes to `--muted`; live and waiting work stays at full `--fg`
 * strength and anchors the eye. This is the ONLY differentiator that is safe in
 * greyscale AND colour-blind vision: it is a lightness step on a
 * contrast-checked ink (`muted` is gated >= 4.5:1 on every surface), never a
 * hue, so it reads the same when the status tones collapse to grey. Callers keep
 * their own weight (`font-semibold`) and hover (`group-hover:text-accent`).
 */
export function nameToneClass(view: SessionView): string {
  return statusMark(view).klass === 'finished' ? 'text-muted' : 'text-fg';
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
  diamond: 'rotate-45 rounded-[1px]',
  square: 'rounded-[1px]',
};

export interface StatusMarkProps {
  readonly view: SessionView;
  readonly size?: number;
  readonly className?: string;
  /** The surface has evidence the session is idle at its prompt; see {@link READY_MARK}. */
  readonly ready?: boolean;
}

/**
 * The glyph. `role="img"` + `aria-label` so it is announced as one thing rather
 * than as an empty span, and `title` so the same words are available on hover.
 */
export function StatusMark({ view, size = 8, className = '', ready = false }: StatusMarkProps) {
  const info = ready ? READY_MARK : statusMark(view);
  return (
    <span
      role="img"
      aria-label={info.label}
      title={info.label}
      // The wrapper keeps a stable, unrotated box so a diamond does not change
      // the row's metrics relative to a circle.
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
