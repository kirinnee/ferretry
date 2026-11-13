/**
 * THE UNDO TOAST: the answer the reader just gave, a countdown, and Undo — for the whole undo window.
 *
 * Nothing has been sent while it shows. `DeferredAgendaActions` holds every answer for
 * `UNDO_WINDOW_MS` and posts it only when the window closes, so Undo is a real undo rather than a second
 * request racing the first. This is only the face of that guarantee.
 *
 * SEVERAL HELD AT ONCE (three quick swipes) read as ONE toast: the most recent answer, its own countdown,
 * and "+2 more" — Undo takes back the most recent, and the toast then shows the one before it. Each
 * answer keeps its own deadline; undoing one never restarts another.
 *
 * A REPLY has the same toast: "Moved to Replied" with Undo for the same window, and once Undo ran, one
 * sentence saying what it did ("Back on your list — zoe already read your reply"). Nothing is held there — the
 * message is already sent — so Undo takes it back out of the queue when it can (`lib/agenda-replied.ts`).
 *
 * The sentence lives in an always-mounted polite live region, so a screen reader hears each new answer
 * once; the ticking seconds are visual only and are never announced. On a phone the toast floats above
 * the bottom tab bar (`agenda-inbox.css`).
 */

import { sessionsBarNames } from '../../lib/ferret-names.ts';
import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgendaInbox } from '../../hooks/use-agenda-inbox.ts';
import { actionSentence } from '../../lib/agenda-inbox.ts';
import type { RepliedEntry, RepliedNotice } from '../../lib/agenda-replied.ts';

/** How often the countdown redraws while something is held. */
const TICK_MS = 250;

/** Whole seconds left before a held answer is sent, never below zero. */
export const secondsLeft = (deadline: number, now: number): number => Math.max(0, Math.ceil((deadline - now) / 1000));

/** The bar under the toast, emptying over what is left of the window — fixed when it mounts. */
function Drain({ remainingMs }: { readonly remainingMs: number }) {
  const [duration] = useState(() => Math.max(0, remainingMs));
  return <span aria-hidden="true" className="fy-attn-undo__drain" style={{ animationDuration: `${duration}ms` }} />;
}

export interface AgendaUndoToastProps {
  readonly inbox: Pick<AgendaInbox, 'deferred' | 'deferredState' | 'replied' | 'repliedState'>;
  /** The clock the countdown reads; the browser's otherwise. Tests pass the deferral's own. */
  readonly clock?: () => number;
  /**
   * Take the toast's own room in the page instead of floating over it. The open Inbox card puts it between the card and the
   * composer, so it can never sit on the input or the send button; without it the toast floats at the bottom as ever.
   */
  readonly inline?: boolean;
}

const toastClass = (inline: boolean): string => `fy-attn-undo kt-panel${inline ? ' fy-attn-undo--inline' : ''}`;

export function AgendaUndoToast({ inbox, clock = Date.now, inline = false }: AgendaUndoToastProps) {
  const pending = inbox.deferredState.pending;
  const latest = pending.at(-1);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (pending.length === 0) return;
    const handle = setInterval(() => setTick(tick => tick + 1), TICK_MS);
    return () => clearInterval(handle);
  }, [pending.length]);

  if (latest === undefined) return <RepliedToast clock={clock} inbox={inbox} inline={inline} />;
  const sentence = actionSentence(latest.action, latest.card.item.id);
  const others = pending.length - 1;
  return (
    <div className={toastClass(inline)} data-agenda-undo="" data-pending={pending.length}>
      <p className="fy-attn-undo__text" role="status">
        {sentence}
      </p>
      {others > 0 ? (
        <span className="fy-attn-undo__more" data-agenda-undo-more="">
          +{others} more
        </span>
      ) : null}
      <span aria-hidden="true" className="fy-attn-undo__count mono" data-agenda-undo-count="">
        {secondsLeft(latest.deadline, clock())}s
      </span>
      <button
        aria-label={`Undo: ${sentence}`}
        className="kt-btn kt-btn--sm fy-attn-undo__button"
        data-agenda-undo-button=""
        onClick={() => inbox.deferred.undo()}
        type="button"
      >
        <Undo2 aria-hidden="true" size={14} />
        Undo
      </button>
      {/* The window draining, keyed per answer so a new one starts full. Decoration only. */}
      <Drain key={`${latest.key}@${latest.deadline}`} remainingMs={latest.deadline - clock()} />
    </div>
  );
}

/** The ferret a card is waiting on, as the sidebar names it. */
const ferretOf = (card: RepliedNotice['card']): string => {
  const names = sessionsBarNames(card.view);
  return names.ferret ?? names.title;
};

/** What Undo did, in one sentence. */
const repliedNoticeSentence = (notice: RepliedNotice): string => {
  const ferret = ferretOf(notice.card);
  switch (notice.kind) {
    case 'withdrawn':
      return 'Reply taken back — your words are back in the box.';
    case 'read':
      return `Back on your list — ${ferret} already read your reply.`;
    case 'unknown':
      return 'Back on your list — your reply may already be with the ferret.';
    case 'refused':
      return `Back on your list — your reply may still reach ${ferret}. ${notice.message ?? ''}`.trim();
    case 'not-back':
      return `Could not put it back on your list. ${notice.message ?? ''}`.trim();
  }
};

/** The reply Undo can still take back: the newest one inside its window. */
const undoableReply = (entries: readonly RepliedEntry[], now: number): RepliedEntry | undefined =>
  entries.findLast(entry => entry.phase === 'replied' && entry.undoUntil > now);

/** The reply's toast: Undo while the window is open, then the one sentence about what Undo did. */
function RepliedToast({ inbox, clock, inline }: Required<AgendaUndoToastProps>) {
  const { entries, notice } = inbox.repliedState;
  const [, setTick] = useState(0);
  const active = entries.some(entry => entry.phase === 'replied') || notice !== null;
  useEffect(() => {
    if (!active) return;
    const handle = setInterval(() => setTick(tick => tick + 1), TICK_MS);
    return () => clearInterval(handle);
  }, [active]);
  const now = clock();
  const entry = undoableReply(entries, now);
  const shown = notice !== null && notice.until > now ? notice : null;
  // The notice is said once; the page forgets it when its time is up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` is the trigger -- the tick re-checks whether the notice has run out
  useEffect(() => {
    if (notice === null || notice.until > clock()) return;
    inbox.replied.clearNotice();
  }, [notice, clock, inbox.replied, now]);

  if (shown !== null) {
    const sentence = repliedNoticeSentence(shown);
    return (
      <div className={toastClass(inline)} data-agenda-replied-notice="" data-agenda-undo="">
        <p className="fy-attn-undo__text fy-attn-undo__text--wide" role="status">
          {sentence}
        </p>
      </div>
    );
  }
  if (entry === undefined) {
    return (
      <div className="sr-only" data-agenda-undo="">
        <p className="fy-attn-undo__text" role="status" />
      </div>
    );
  }
  const sentence = 'Moved to Replied';
  return (
    <div className={toastClass(inline)} data-agenda-replied-toast="" data-agenda-undo="">
      <p className="fy-attn-undo__text" role="status">
        {sentence}
      </p>
      <span aria-hidden="true" className="fy-attn-undo__count mono" data-agenda-undo-count="">
        {secondsLeft(entry.undoUntil, now)}s
      </span>
      <button
        aria-label={`Undo: ${sentence}`}
        className="kt-btn kt-btn--sm fy-attn-undo__button"
        data-agenda-undo-button=""
        onClick={() => void inbox.replied.undo(entry.key)}
        type="button"
      >
        <Undo2 aria-hidden="true" size={14} />
        Undo
      </button>
      <Drain key={`${entry.key}@${entry.undoUntil}`} remainingMs={entry.undoUntil - now} />
    </div>
  );
}
