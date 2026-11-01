/**
 * THE INBOX'S "READY TO TEST" ITEMS: cards in a verify lane, waiting for the owner's Done or Not good.
 *
 * - SWIPE RIGHT IS DONE, LEFT IS NOT GOOD, the same sideways swipe the agenda deck has (touch only, decided after the
 *   same slop, committed past the same threshold, never started on something the reader presses or inside a sideways
 *   scroller). What letting go would do is kept as `data-swipe-*` and named (icon + word) in the area the row uncovers.
 * - THE BUTTONS ARE THE SAME TWO ANSWERS for a mouse, a keyboard and a screen reader.
 * - NOTHING CLOSES A CARD HERE THAT THE BOARD DOES NOT: both answers go through `useBoardAnswers`, the Board's own flow.
 *   Done moves the card forward at once; Not good opens the Board's reason box and reopens the card with the owner's
 *   words as the ask.
 */

import { Check, ThumbsDown, X } from 'lucide-react';
import { type PointerEvent, useMemo, useRef, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import { swipeIntent, swipeThreshold } from '../../lib/agenda-inbox.ts';
import type { BoardActions } from '../../lib/board-actions.ts';
import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import { daemonBoardCardPath } from '../../lib/pages/routes.ts';
import { releaseWords, type ToTestCard } from '../../lib/to-test-inbox.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { useBoardAnswers } from '../board/board-answers.tsx';
import type { SendBackPorts } from '../board/board-send-back.tsx';
import { cardProse, HowToTest } from '../board/detail/board-detail-sections.tsx';
import { isTouch, lockOf, startsInSidewaysScroller, startsOnInteractive } from './agenda-swipe-gesture.ts';

/** What the rows need to move a card: the Board's own verbs, bound to the paired machines. */
export interface ToTestHost {
  readonly actions: Pick<BoardActions, 'moveTask'>;
  readonly ports: SendBackPorts | undefined;
  readonly connectionOf: (daemonId: DaemonId) => DaemonConnection | undefined;
}

const NO_HOST: ToTestHost = {
  actions: {
    moveTask: async () => ({ ok: false, error: { code: 'unavailable', message: 'This page cannot move cards.' } }),
  } as unknown as Pick<BoardActions, 'moveTask'>,
  ports: undefined,
  connectionOf: () => undefined,
};

/** The answers on the rows, and the reason box a Not good opens (draw `composer` once on the page). */
export const useToTestAnswers = (host: ToTestHost | undefined, phone: boolean) => {
  const [notice, setNotice] = useState<string | null>(null);
  const live = host ?? NO_HOST;
  const { requestMove, answerFor, composer } = useBoardAnswers({
    actions: live.actions,
    ports: live.ports,
    connectionOf: live.connectionOf,
    phone,
    onNotice: setNotice,
    portal: true,
  });
  return {
    notice,
    composer,
    answerFor,
    done: (row: ToTestCard): void => requestMove(row.card, row.group, row.doneLaneId, 'done'),
    notGood: (row: ToTestCard): void => requestMove(row.card, row.group, row.notGoodLaneId, 'not-good'),
  };
};

export type ToTestAnswers = ReturnType<typeof useToTestAnswers>;

interface Drag {
  readonly dx: number;
  readonly width: number;
}

/** A sideways swipe on one row: right is `onRight`, left is `onLeft`. */
const useRowSwipe = (onRight: () => void, onLeft: () => void, disabled: boolean) => {
  const gesture = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly width: number;
    moved: boolean;
    dx: number;
  } | null>(null);
  const swallowClick = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const targets = useMemo(() => ({ left: true, right: true }), []);

  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    swallowClick.current = false;
    if (
      disabled ||
      !isTouch(event) ||
      startsOnInteractive(event.target) ||
      startsInSidewaysScroller(event.target, event.currentTarget)
    )
      return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: event.currentTarget.getBoundingClientRect().width,
      moved: false,
      dx: 0,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved) {
      const lock = lockOf(dx, dy);
      if (lock === null) return;
      if (lock === 'vertical') {
        gesture.current = null;
        return;
      }
      current.moved = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser already released cannot be captured; the drag still reads.
      }
    }
    current.dx = dx;
    setDrag({ dx, width: current.width });
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!current.moved) return;
    swallowClick.current = true;
    const intent = swipeIntent(current.dx, 0, current.width, targets);
    setDrag(null);
    if (intent.committed) (intent.direction === 'right' ? onRight : onLeft)();
  };
  const onPointerCancel = (event: PointerEvent<HTMLElement>): void => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDrag(null);
  };
  const onClickCapture = (event: { preventDefault: () => void; stopPropagation: () => void }): void => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const intent = drag === null ? null : swipeIntent(drag.dx, 0, drag.width, targets);
  // The row follows the finger, but never further than the commit distance plus a little give.
  const reach = drag === null ? 0 : swipeThreshold(drag.width) * 1.25;
  const offset = drag === null ? 0 : Math.max(-reach, Math.min(reach, drag.dx));
  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture },
    offset,
    intent,
  };
};

const ANSWER_WORD = { right: 'Done', left: 'Not good' } as const;

function ToTestRow({
  row,
  answers,
  now,
  onNavigate,
}: {
  readonly row: ToTestCard;
  readonly answers: ToTestAnswers;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
}) {
  const state = answers.answerFor(row.card);
  const busy = state.pressed !== null;
  const { done, notGood } = answers;
  const swipe = useRowSwipe(
    () => done(row),
    () => notGood(row),
    busy,
  );
  const direction =
    swipe.intent?.direction === 'left' || swipe.intent?.direction === 'right' ? swipe.intent.direction : null;
  const release = releaseWords(row.card.task.shippedIn);
  const title = row.card.task.title;
  const empty = row.howToTest.trim() === '';
  return (
    <li
      className="fy-totest"
      data-swipe-direction={direction ?? undefined}
      data-swipe-committed={swipe.intent?.committed || undefined}
      data-swipe-answer={direction === null ? undefined : ANSWER_WORD[direction]}
      data-to-test={row.key}
    >
      <span aria-hidden="true" className="fy-totest__reveal" data-side="right" data-to-test-reveal="right">
        <Check size={16} />
        Done
      </span>
      <span aria-hidden="true" className="fy-totest__reveal" data-side="left" data-to-test-reveal="left">
        Not good
        <X size={16} />
      </span>
      <div
        className="fy-totest__surface"
        data-dragging={swipe.intent === null ? undefined : ''}
        {...swipe.handlers}
        style={{
          touchAction: 'pan-y',
          transform: swipe.offset === 0 ? undefined : `translate3d(${swipe.offset}px, 0, 0)`,
        }}
      >
        <div className="fy-totest__top">
          <RouteLink
            className="fy-totest__title"
            data-to-test-title=""
            onNavigate={onNavigate}
            to={daemonBoardCardPath(row.card.daemonId, row.card.task.id)}
          >
            {title}
          </RouteLink>
          <span className="fy-totest__age">{ageWords(row.since, now)}</span>
        </div>
        <p className="fy-totest__meta">
          <span>{row.card.machine}</span>
          {release === null ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span data-to-test-release="">{release}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>Ready to test</span>
        </p>
        {empty ? null : (
          <section aria-label={`How to test ${title}`} className="fy-totest__how" data-to-test-how="">
            <h3 className="fy-totest__how-title">How to test</h3>
            <HowToTest renderProse={cardProse} text={row.howToTest} />
          </section>
        )}
        {state.error === null ? null : (
          <p className="fy-totest__error" data-to-test-error="" role="alert">
            {state.error}
          </p>
        )}
        <div className="fy-totest__actions">
          <button
            aria-label={`Not good: ${title}`}
            className="kt-btn"
            data-to-test-not-good=""
            data-variant="ghost"
            disabled={busy}
            onClick={() => notGood(row)}
            type="button"
          >
            {state.pressed === 'not-good' ? <Spinner size={14} /> : <ThumbsDown aria-hidden="true" size={14} />}
            Not good
          </button>
          <button
            aria-label={`Done: ${title}`}
            className="kt-btn"
            data-to-test-done=""
            data-variant="primary"
            disabled={busy}
            onClick={() => done(row)}
            type="button"
          >
            {state.pressed === 'done' ? <Spinner size={14} /> : <Check aria-hidden="true" size={14} />}
            Done
          </button>
        </div>
      </div>
    </li>
  );
}

const ageWords = (since: string | null, now: number | undefined): string => {
  if (since === null) return '';
  const ms = Math.max(0, (now ?? Date.now()) - Date.parse(since));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

/** The rows of the cards waiting for a try, newest release first. */
export function ToTestList({
  rows,
  answers,
  now,
  onNavigate,
}: {
  readonly rows: readonly ToTestCard[];
  readonly answers: ToTestAnswers;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
}) {
  return (
    <ul aria-label="Ready to test" className="fy-totest-list" data-to-test-list="">
      {rows.map(row => (
        <ToTestRow answers={answers} key={row.key} now={now} onNavigate={onNavigate} row={row} />
      ))}
    </ul>
  );
}
