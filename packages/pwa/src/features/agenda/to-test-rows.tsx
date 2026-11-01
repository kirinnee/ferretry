/**
 * "READY TO TEST" ITEMS: cards in a verify lane, waiting for the owner's Done or Not good. The Inbox lists them and the
 * chat task panel's Cards view draws one at a time; both draw this one row, so the gesture, the buttons and the reason
 * box are the same on both.
 *
 * - SWIPE LEFT IS DONE, RIGHT IS NOT GOOD, DOWN IS SKIP, the same swipe the agenda deck has (touch only, decided after the
 *   same slop, committed past the same threshold, never started on something the reader presses or inside a sideways
 *   scroller). DOWN is read only from the row's head (its title line and who-and-what line), the part that does not
 *   scroll, so a drag down anywhere else is still the page scrolling. Skip changes nothing: it goes to the next card.
 *   What letting go would do is kept as `data-swipe-*` and named (icon + word) in the area the row uncovers.
 * - THE BUTTONS ARE THE SAME ANSWERS for a mouse, a keyboard and a screen reader, in the order of the swipes.
 * - NOTHING CLOSES A CARD HERE THAT THE BOARD DOES NOT: both answers go through `useBoardAnswers`, the Board's own flow.
 *   Done moves the card forward at once; Not good opens the Board's reason box and reopens the card with the owner's
 *   words as the ask.
 */

import { Check, SkipForward, ThumbsDown, X } from 'lucide-react';
import { type PointerEvent, useRef, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import { SWIPE_SLOP_PX, swipeIntent, swipeThreshold } from '../../lib/agenda-inbox.ts';
import type { BoardActions } from '../../lib/board-actions.ts';
import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import { daemonBoardCardPath } from '../../lib/pages/routes.ts';
import { releaseWords, type ToTestCard } from '../../lib/to-test-inbox.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { type BoardAnswers, useBoardAnswers } from '../board/board-answers.tsx';
import type { SendBackPorts } from '../board/board-send-back.tsx';
import { cardProse, HowToTest } from '../board/detail/board-detail-sections.tsx';
import { AgendaSnoozeMenu } from './agenda-snooze-menu.tsx';
import { isTouch, lockOf, startsInSidewaysScroller, startsOnInteractive } from './agenda-swipe-gesture.ts';

/** What the rows need to move a card: the Board's own verbs, bound to the paired machines. */
export interface ToTestHost {
  readonly actions: Pick<BoardActions, 'moveTask' | 'snoozeTask'>;
  readonly ports: SendBackPorts | undefined;
  readonly connectionOf: (daemonId: DaemonId) => DaemonConnection | undefined;
}

const NO_HOST: ToTestHost = {
  actions: {
    moveTask: async () => ({ ok: false, error: { code: 'unavailable', message: 'This page cannot move cards.' } }),
    snoozeTask: async () => ({ ok: false, error: { code: 'unavailable', message: 'This page cannot snooze cards.' } }),
  } as unknown as Pick<BoardActions, 'moveTask' | 'snoozeTask'>,
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
    ...toTestAnswersOver({ requestMove, answerFor, snooze: snoozeOver(live.actions, setNotice) }),
  };
};

/** What a row needs to answer a card: any surface holding the Board's own `useBoardAnswers` flow can hand these over. */
export interface ToTestAnswers {
  readonly answerFor: BoardAnswers['answerFor'];
  readonly done: (row: ToTestCard) => void;
  readonly notGood: (row: ToTestCard) => void;
  /** Park the card until `until`, or wake it now (`null`). It is the owner's, kept on the machine, so every device agrees. */
  readonly snooze: (row: ToTestCard, until: string | null) => void;
}

/** The snooze verb for a row: a refusal is said where the page says its other notices. */
export const snoozeOver =
  (actions: Pick<BoardActions, 'snoozeTask'>, onNotice: (message: string) => void) =>
  (row: ToTestCard, until: string | null): void => {
    void actions.snoozeTask({ daemonId: row.card.daemonId, id: row.card.task.id }, until).then(result => {
      if (!result.ok) onNotice(result.error.message);
    });
  };

export const toTestAnswersOver = ({
  requestMove,
  answerFor,
  snooze,
}: Pick<BoardAnswers, 'requestMove' | 'answerFor'> & { readonly snooze: ToTestAnswers['snooze'] }): ToTestAnswers => ({
  answerFor,
  snooze,
  done: row => requestMove(row.card, row.group, row.doneLaneId, 'done'),
  notGood: row => requestMove(row.card, row.group, row.notGoodLaneId, 'not-good'),
});

type RowDirection = 'left' | 'right' | 'down';

interface Drag {
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
}

interface RowIntent {
  readonly direction: RowDirection | null;
  readonly committed: boolean;
}

const SIDEWAYS = { left: true, right: true } as const;

/** What letting go of a drag would do: sideways answers, and DOWN only where it is a skip. */
const rowIntent = (drag: Drag, down: boolean): RowIntent => {
  if (down && drag.dy > Math.abs(drag.dx)) {
    if (drag.dy < SWIPE_SLOP_PX) return { direction: null, committed: false };
    return { direction: 'down', committed: drag.dy >= swipeThreshold(drag.width) };
  }
  const { direction, committed } = swipeIntent(drag.dx, 0, drag.width, SIDEWAYS);
  return { direction: direction === 'left' || direction === 'right' ? direction : null, committed };
};

/** The row's head: its title line and who-and-what line. It does not scroll, so a drag down there is a swipe. */
const startsInRowHead = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('.fy-totest__top, .fy-totest__meta') !== null;

/** A swipe on one row: left is `onLeft`, right is `onRight`, and down (from the head) is `onDown`. */
const useRowSwipe = (onLeft: () => void, onRight: () => void, onDown: () => void, disabled: boolean) => {
  const gesture = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly width: number;
    readonly head: boolean;
    axis: 'sideways' | 'vertical' | null;
    dx: number;
    dy: number;
  } | null>(null);
  const swallowClick = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);

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
      head: startsInRowHead(event.target),
      axis: null,
      dx: 0,
      dy: 0,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.axis === null) {
      const lock = lockOf(dx, dy);
      if (lock === null) return;
      // Down belongs to the head; everywhere else a vertical drag is the page scrolling, and up is nothing.
      if (lock === 'vertical' && !(current.head && dy > 0)) {
        gesture.current = null;
        return;
      }
      current.axis = lock;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser already released cannot be captured; the drag still reads.
      }
    }
    current.dx = current.axis === 'sideways' ? dx : 0;
    current.dy = current.axis === 'vertical' ? Math.max(0, dy) : 0;
    setDrag({ dx: current.dx, dy: current.dy, width: current.width });
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (current.axis === null) return;
    swallowClick.current = true;
    const intent = rowIntent({ dx: current.dx, dy: current.dy, width: current.width }, true);
    setDrag(null);
    if (!intent.committed) return;
    if (intent.direction === 'left') onLeft();
    else if (intent.direction === 'right') onRight();
    else onDown();
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

  const intent = drag === null ? null : rowIntent(drag, true);
  // The row follows the finger, but never further than the commit distance plus a little give.
  const reach = drag === null ? 0 : swipeThreshold(drag.width) * 1.25;
  const clamp = (value: number): number => Math.max(-reach, Math.min(reach, value));
  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture },
    offsetX: drag === null ? 0 : clamp(drag.dx),
    offsetY: drag === null ? 0 : clamp(drag.dy),
    intent,
  };
};

const ANSWER_WORD = { left: 'Done', right: 'Not good', down: 'Skip' } as const;

function ToTestRow({
  row,
  answers,
  now,
  onNavigate,
  onSkip,
  skipButton,
}: {
  readonly row: ToTestCard;
  readonly answers: ToTestAnswers;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly onSkip: (row: ToTestCard) => void;
  readonly skipButton: boolean;
}) {
  const state = answers.answerFor(row.card);
  const busy = state.pressed !== null;
  const { done, notGood, snooze } = answers;
  const swipe = useRowSwipe(
    () => done(row),
    () => notGood(row),
    () => onSkip(row),
    busy,
  );
  const direction = swipe.intent?.direction ?? null;
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
        <X size={16} />
        Not good
      </span>
      <span aria-hidden="true" className="fy-totest__reveal" data-side="left" data-to-test-reveal="left">
        Done
        <Check size={16} />
      </span>
      <span aria-hidden="true" className="fy-totest__reveal" data-side="down" data-to-test-reveal="down">
        <SkipForward size={16} />
        Skip
      </span>
      <div
        className="fy-totest__surface"
        data-dragging={swipe.intent === null ? undefined : ''}
        {...swipe.handlers}
        style={{
          touchAction: 'pan-y',
          transform:
            swipe.offsetX === 0 && swipe.offsetY === 0
              ? undefined
              : `translate3d(${swipe.offsetX}px, ${swipe.offsetY}px, 0)`,
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
          {row.taskName === null ? null : (
            <span className="fy-totest__ferret" data-to-test-ferret="">
              {row.taskName}
            </span>
          )}
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
          <AgendaSnoozeMenu
            disabled={busy}
            label={`Snooze: ${title}`}
            now={now}
            onSnooze={until => snooze(row, until)}
            triggerClass="kt-btn fy-totest__snooze"
          />
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
          {skipButton ? (
            <button
              aria-label={`Skip: ${title}`}
              className="kt-btn"
              data-to-test-skip=""
              data-variant="ghost"
              disabled={busy}
              onClick={() => onSkip(row)}
              type="button"
            >
              <SkipForward aria-hidden="true" size={14} />
              Skip
            </button>
          ) : null}
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

/**
 * The rows of the cards waiting for a try, newest release first. `onSkip` is where Skip goes (the run's next card,
 * the Cards view's next card) and gives the rows a Skip button; with none, a swipe down brings the next row into view.
 */
export function ToTestList({
  rows,
  answers,
  now,
  onNavigate,
  onSkip,
}: {
  readonly rows: readonly ToTestCard[];
  readonly answers: ToTestAnswers;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly onSkip?: (row: ToTestCard) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const scrollToNext = (row: ToTestCard): void => {
    const current = [...(list.current?.children ?? [])].find(item => item.getAttribute('data-to-test') === row.key);
    current?.nextElementSibling?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  return (
    <ul aria-label="Ready to test" className="fy-totest-list" data-to-test-list="" ref={list}>
      {rows.map(row => (
        <ToTestRow
          answers={answers}
          key={row.key}
          now={now}
          onNavigate={onNavigate}
          onSkip={onSkip ?? scrollToNext}
          row={row}
          skipButton={onSkip !== undefined}
        />
      ))}
    </ul>
  );
}
