/**
 * THE UNDO TOAST: the answer the reader just gave, a countdown, and Undo — for the whole undo window.
 *
 * Nothing has been sent while it shows. `DeferredAttentionActions` holds every answer for
 * `UNDO_WINDOW_MS` and posts it only when the window closes, so Undo is a real undo rather than a second
 * request racing the first. This is only the face of that guarantee.
 *
 * SEVERAL HELD AT ONCE (three quick swipes) read as ONE toast: the most recent answer, its own countdown,
 * and "+2 more" — Undo takes back the most recent, and the toast then shows the one before it. Each
 * answer keeps its own deadline; undoing one never restarts another.
 *
 * The sentence lives in an always-mounted polite live region, so a screen reader hears each new answer
 * once; the ticking seconds are visual only and are never announced. On a phone the toast floats above
 * the bottom tab bar (`attention-inbox.css`).
 */

import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AttentionInbox } from '../../hooks/use-attention-inbox.ts';
import { actionSentence } from '../../lib/attention-inbox.ts';

/** How often the countdown redraws while something is held. */
const TICK_MS = 250;

/** Whole seconds left before a held answer is sent, never below zero. */
export const secondsLeft = (deadline: number, now: number): number => Math.max(0, Math.ceil((deadline - now) / 1000));

/** The bar under the toast, emptying over what is left of the window — fixed when it mounts. */
function Drain({ remainingMs }: { readonly remainingMs: number }) {
  const [duration] = useState(() => Math.max(0, remainingMs));
  return <span aria-hidden="true" className="fy-attn-undo__drain" style={{ animationDuration: `${duration}ms` }} />;
}

export interface AttentionUndoToastProps {
  readonly inbox: Pick<AttentionInbox, 'deferred' | 'deferredState'>;
  /** The clock the countdown reads; the browser's otherwise. Tests pass the deferral's own. */
  readonly clock?: () => number;
}

export function AttentionUndoToast({ inbox, clock = Date.now }: AttentionUndoToastProps) {
  const pending = inbox.deferredState.pending;
  const latest = pending.at(-1);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (pending.length === 0) return;
    const timer = setInterval(() => setTick(tick => tick + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [pending.length]);

  const sentence = latest === undefined ? '' : actionSentence(latest.action, latest.card.item.id);
  const others = pending.length - 1;
  return (
    <div
      className={latest === undefined ? 'sr-only' : 'fy-attn-undo kt-panel'}
      data-attention-undo=""
      data-pending={pending.length}
    >
      <p className="fy-attn-undo__text" role="status">
        {sentence}
      </p>
      {latest === undefined ? null : (
        <>
          {others > 0 ? (
            <span className="fy-attn-undo__more" data-attention-undo-more="">
              +{others} more
            </span>
          ) : null}
          <span aria-hidden="true" className="fy-attn-undo__count mono" data-attention-undo-count="">
            {secondsLeft(latest.deadline, clock())}s
          </span>
          <button
            aria-label={`Undo: ${sentence}`}
            className="kt-btn kt-btn--sm fy-attn-undo__button"
            data-attention-undo-button=""
            onClick={() => inbox.deferred.undo()}
            type="button"
          >
            <Undo2 aria-hidden="true" size={14} />
            Undo
          </button>
          {/* The window draining, keyed per answer so a new one starts full. Decoration only. */}
          <Drain key={`${latest.key}@${latest.deadline}`} remainingMs={latest.deadline - clock()} />
        </>
      )}
    </div>
  );
}
