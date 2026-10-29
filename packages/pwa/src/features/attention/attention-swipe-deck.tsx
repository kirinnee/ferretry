/**
 * THE PHONE'S ATTENTION DECK: the newest card on top, draggable; the next ones peeking out behind it.
 *
 * A swipe is an answer, so it is held to the same rules a button is, and then some:
 *
 * - THE MAPPING IS THE CARD'S OWN ANSWERS (`swipeTargets`), never a second one: left, up and right each
 *   give the answer the card put in that direction, carrying the reply typed on the card as its note. A
 *   direction with no answer commits nothing. While the card is dragged the answer it would send is
 *   STAMPED on it — arrow and label, growing with the drag — so the reader sees what they are about to
 *   say before they say it. A review's "Needs changes" with an empty reply box opens the box instead.
 * - IT COMMITS ONLY PAST THE THRESHOLD (`swipeIntent(...).committed`). Short of it the card springs back
 *   and nothing is sent; past it the card flies off and the answer is handed to `onAct` — which, in the
 *   inbox, holds it for the undo window (`DeferredAttentionActions`) rather than posting it.
 * - A SCROLL IS NEVER A SWIPE. `touch-action` hands the browser every direction the card does not use:
 *   with no third option the card keeps vertical panning entirely (`pan-y`), and with one it keeps only
 *   the downward pan (`pan-down`) — a drag down means nothing to `swipeIntent` for the same reason.
 *   A drag never starts in the reply box, and a drag that moved swallows the click it ends in, so
 *   swiping across a button does not also press it.
 * - KEYBOARD AND SCREEN-READER PARITY: the same answers are the card's own buttons, and a focused card
 *   takes ←, → and ↑ for the mapped answer ({@link AttentionCardFrame}), said in an sr-only hint.
 * - REDUCED MOTION (the OS preference, or Settings › Appearance › Motion) drops the fly-off and the
 *   spring: the card is simply gone, or simply back.
 */

import { attentionTitle } from '@ferretry/protocol';
import { ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  directionOfAction,
  type InboxAction,
  type InboxCard,
  SWIPE_SLOP_PX,
  type SwipeDirection,
  swipeIntent,
  swipeMap,
} from '../../lib/attention-inbox.ts';
import { type SwipeTarget, type SwipeTargets, swipeTargets } from '../../lib/attention-answers.ts';
import { usePrefersReducedMotion } from '../../shell/bottom-sheet.tsx';
import { ReplyDraftContext } from './attention-reply-draft.tsx';

/** How long a committed card takes to leave. The answer is handed over at once; this is only the look. */
const FLY_MS = 220;

/** How many cards peek out behind the top one. */
const PEEKS = 2;

const KEY_DIRECTION: Readonly<Record<string, SwipeDirection>> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowUp: 'up',
};

const DIRECTION_WORD: Readonly<Record<SwipeDirection, string>> = { right: 'right', left: 'left', up: 'up' };

/** The direction a key points, or `null` for a key that is not one of the three arrows. */
export const attentionKeyDirection = (key: string): SwipeDirection | null => KEY_DIRECTION[key] ?? null;

/** What the arrows do on this card, in words: the sr-only hint a focused card is described by. */
export const swipeKeyHint = (targets: SwipeTargets): string =>
  (['left', 'up', 'right'] as const)
    .flatMap(direction => {
      const target = targets[direction];
      return target === undefined ? [] : [`Arrow ${DIRECTION_WORD[direction]}: ${target.label}.`];
    })
    .join(' ');

/** Reduced motion from either source: the OS preference, or the app's own Motion setting. */
const useReducedMotion = (override?: boolean): boolean => {
  const prefers = usePrefersReducedMotion();
  if (override !== undefined) return override;
  return prefers || (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced');
};

interface AttentionCardFrameProps {
  readonly card: InboxCard;
  readonly targets: SwipeTargets;
  readonly onArrow: (direction: SwipeDirection) => void;
  readonly children: ReactNode;
}

/**
 * A card as something the keyboard can answer: focusable, described by what its arrows do, and taking
 * ←/→/↑ for the answer in that direction — only when the CARD is focused, never while focus is in its
 * reply box or on one of its buttons, where the arrows already mean something.
 */
function AttentionCardFrame({ card, targets, onArrow, children }: AttentionCardFrameProps) {
  const hintId = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    const direction = attentionKeyDirection(event.key);
    if (direction === null || targets[direction] === undefined) return;
    event.preventDefault();
    onArrow(direction);
  };
  return (
    <section
      aria-describedby={hintId}
      aria-label={attentionTitle(card.item)}
      className="fy-attn-frame"
      data-attention-frame={card.item.id}
      onKeyDown={onKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the card is focusable so its arrow keys can answer it; the hint says how
      tabIndex={0}
    >
      {children}
      <span className="sr-only" id={hintId}>
        {swipeKeyHint(targets)}
      </span>
    </section>
  );
}

const STAMP_ARROW: Readonly<Record<SwipeDirection, ReactNode>> = {
  right: <ArrowRight size={20} aria-hidden="true" />,
  left: <ArrowLeft size={20} aria-hidden="true" />,
  up: <ArrowUp size={20} aria-hidden="true" />,
};

interface Drag {
  readonly dx: number;
  readonly dy: number;
}

/** A drag in progress, as the pointer moved it: raw, before {@link dragOffset} draws it. */
interface RawDrag extends Drag {
  readonly width: number;
}

interface Gesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  moved: boolean;
  dx: number;
  dy: number;
}

interface Leaving {
  readonly card: InboxCard;
  readonly direction: SwipeDirection;
  readonly from: Drag;
}

/** Where a drag of `(dx, dy)` draws the card: it follows sideways, and up only when up means something. */
export const dragOffset = (dx: number, dy: number, targets: SwipeTargets): Drag => ({
  dx,
  dy: dy >= 0 ? 0 : targets.up === undefined ? dy * 0.2 : dy,
});

/** A drag never starts where the reader types. */
const startsInField = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('textarea, input, select, [contenteditable="true"]') !== null;

export interface AttentionSwipeDeckProps {
  /** The deck, newest first: the first card is on top. */
  readonly cards: readonly InboxCard[];
  /** Draws one card; `act` is how its own buttons answer it (and fly it off, like a swipe). */
  readonly renderCard: (card: InboxCard, act: (action: InboxAction) => void) => ReactNode;
  /** An answer the reader gave, by swipe, arrow key or button. */
  readonly onAct: (card: InboxCard, action: InboxAction) => void;
  /** Forces reduced motion on or off; the reader's preference otherwise. */
  readonly reducedMotion?: boolean;
}

const NO_ACT = (): void => undefined;

export function AttentionSwipeDeck({ cards, renderCard, onAct, reducedMotion }: AttentionSwipeDeckProps) {
  const reduced = useReducedMotion(reducedMotion);
  const [drag, setDrag] = useState<RawDrag | null>(null);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [replyText, setReplyText] = useState('');
  const [focusTick, setFocusTick] = useState(0);
  const gesture = useRef<Gesture | null>(null);
  const deck = useRef<HTMLDivElement | null>(null);
  /** Focus was in the deck when a card left: the next card takes it, so the keyboard keeps its place. */
  const refocus = useRef(false);
  const swallowClick = useRef(false);
  const top = cards[0];
  const targets: SwipeTargets = top === undefined ? {} : swipeTargets(top.item, replyText);

  const topKey = top?.key;
  // A new card on top starts with no drag and no reply — the old one's must never carry over — and
  // takes the focus the card it replaced had.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the card on top changing is the only trigger
  useEffect(() => {
    gesture.current = null;
    setDrag(null);
    setReplyText('');
    if (!refocus.current) return;
    // The last card leaving forgets the focus too: a card arriving later must not steal it.
    refocus.current = false;
    if (topKey === undefined) return;
    deck.current?.querySelector<HTMLElement>('.fy-attn-deck__top [data-attention-frame]')?.focus();
  }, [topKey]);

  useEffect(() => {
    if (leaving === null) return;
    const timer = setTimeout(() => setLeaving(null), FLY_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const answer = (card: InboxCard, action: InboxAction, from: Drag): void => {
    const direction = directionOfAction(swipeMap(card.item, replyText), action);
    refocus.current = deck.current?.contains(document.activeElement) === true;
    gesture.current = null;
    setDrag(null);
    if (!reduced && direction !== null) setLeaving({ card, direction, from });
    onAct(card, action);
  };

  /** A swipe or arrow toward `direction`: its answer goes, or — a "Needs changes" with no text — the box opens. */
  const give = (card: InboxCard, direction: SwipeDirection, from: Drag): void => {
    const target = targets[direction];
    // Both callers give only a direction the card takes (a committed swipe, a mapped arrow); the guard
    // keeps a future caller from sending nothing. A "Needs changes" with no words opens the box instead.
    if (target === undefined || target.action === null) {
      setDrag(null);
      if (target !== undefined) setFocusTick(tick => tick + 1);
      return;
    }
    answer(card, target.action, from);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    swallowClick.current = false;
    if (top === undefined || (event.pointerType === 'mouse' && event.button !== 0) || startsInField(event.target))
      return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: event.currentTarget.getBoundingClientRect().width,
      moved: false,
      dx: 0,
      dy: 0,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    current.dx = event.clientX - current.startX;
    current.dy = event.clientY - current.startY;
    if (!current.moved) {
      if (Math.hypot(current.dx, current.dy) < SWIPE_SLOP_PX) return;
      current.moved = true;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser already released cannot be captured; the drag still reads.
      }
    }
    setDrag({ dx: current.dx, dy: current.dy, width: current.width });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId || top === undefined) return;
    gesture.current = null;
    if (!current.moved) return;
    swallowClick.current = true;
    const intent = swipeIntent(current.dx, current.dy, current.width, targets);
    if (intent.committed && intent.direction !== null)
      give(top, intent.direction, dragOffset(current.dx, current.dy, targets));
    else setDrag(null);
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDrag(null);
  };

  if (top === undefined && leaving === null) return null;

  const intent = drag === null ? null : swipeIntent(drag.dx, drag.dy, drag.width, targets);
  const offset = drag === null ? null : dragOffset(drag.dx, drag.dy, targets);
  const stamp: SwipeTarget | undefined = intent?.direction == null ? undefined : targets[intent.direction];
  const peeks = cards.slice(1, 1 + PEEKS);

  return (
    <div className="fy-attn-deck" data-attention-deck="" data-reduced-motion={reduced || undefined} ref={deck}>
      {peeks
        .map((card, index) => (
          <div aria-hidden="true" className="fy-attn-deck__peek" data-depth={index + 1} inert key={card.key}>
            {renderCard(card, NO_ACT)}
          </div>
        ))
        .reverse()}
      {top === undefined ? null : (
        <div
          className="fy-attn-deck__top"
          data-dragging={drag === null ? undefined : ''}
          data-swipe-direction={intent?.direction ?? undefined}
          key={top.key}
          onClickCapture={event => {
            if (!swallowClick.current) return;
            swallowClick.current = false;
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerCancel={onPointerCancel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{
            touchAction: targets.up === undefined ? 'pan-y' : 'pan-down',
            ...(offset === null
              ? {}
              : {
                  transform: `translate3d(${offset.dx}px, ${offset.dy}px, 0) rotate(${(offset.dx / 24).toFixed(2)}deg)`,
                }),
          }}
        >
          <AttentionCardFrame
            card={top}
            onArrow={direction => give(top, direction, { dx: 0, dy: 0 })}
            targets={targets}
          >
            <ReplyDraftContext.Provider value={{ text: replyText, setText: setReplyText, focusTick }}>
              {renderCard(top, action => answer(top, action, { dx: 0, dy: 0 }))}
            </ReplyDraftContext.Provider>
          </AttentionCardFrame>
          {intent === null || intent.direction === null ? null : (
            <div
              aria-hidden="true"
              className="fy-attn-deck__stamp"
              data-attention-stamp={intent.direction}
              data-committed={intent.committed || undefined}
              data-empty={stamp === undefined || undefined}
              style={{ '--stamp-progress': intent.progress.toFixed(2) } as CSSProperties}
            >
              {STAMP_ARROW[intent.direction]}
              <span>{stamp?.label ?? 'Nothing this way'}</span>
            </div>
          )}
        </div>
      )}
      {leaving === null ? null : (
        <div
          aria-hidden="true"
          className="fy-attn-deck__leaving"
          data-direction={leaving.direction}
          inert
          key={`leaving-${leaving.card.key}`}
          style={{ '--fly-x': `${leaving.from.dx}px`, '--fly-y': `${leaving.from.dy}px` } as CSSProperties}
        >
          {renderCard(leaving.card, NO_ACT)}
        </div>
      )}
    </div>
  );
}
