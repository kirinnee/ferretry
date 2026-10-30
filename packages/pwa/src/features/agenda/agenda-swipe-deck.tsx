/**
 * THE PHONE'S AGENDA DECK: the newest card on top, draggable; the next ones peeking out behind it.
 *
 * A swipe is an answer, so it is held to the same rules a button is, and then some:
 *
 * - THE MAPPING IS THE CARD'S OWN ANSWERS (`swipeTargets`), never a second one: left, up and right each
 *   give the answer the card put in that direction. A direction with no answer commits nothing. While the
 *   card is dragged the answer it would send is STAMPED on it — arrow and label, growing with the drag —
 *   so the reader sees what they are about to say before they say it. A review's "Needs changes" is
 *   written in the message box, so it has no swipe: that drag springs back.
 * - IT COMMITS ONLY PAST THE THRESHOLD (`swipeIntent(...).committed`). Short of it the card springs back
 *   and nothing is sent; past it the card flies off and the answer is handed to `onAct` — which, in the
 *   inbox, holds it for the undo window (`DeferredAgendaActions`) rather than posting it.
 * - DOWN IS NOTHING: a drag down answers nothing and the card does not follow it; the browser keeps it as a scroll.
 * - A SWIPE STARTS ONLY FROM THE CARD'S HEAD ({@link startsInHandle}): its header and title. The detail
 *   below is its own scroller and the answer bar is for pressing, so a drag there is the reader scrolling
 *   or tapping, never an answer — the card is the full height of the screen, and most of it scrolls.
 * - A SCROLL IS NEVER A SWIPE. `touch-action` on the card hands the browser every direction the card does
 *   not use: with no up answer it keeps vertical panning entirely (`pan-y`), and with one it keeps only
 *   the downward pan (`pan-down`) — the detail inside it scrolls on that rule.
 *   A drag that moved swallows the click it ends in, so a swipe that ends over a button does not also
 *   press it.
 * - KEYBOARD AND SCREEN-READER PARITY: the same answers are the card's own buttons, and a focused card
 *   takes ←, → and ↑ for the mapped answer ({@link AgendaCardFrame}), said in an sr-only hint.
 * - REDUCED MOTION (the OS preference, or Settings › Appearance › Motion) drops the fly-off and the
 *   spring: the card is simply gone, or simply back.
 */

import { agendaTitle } from '@ferretry/protocol';
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
import { type SwipeTarget, type SwipeTargets, swipeTargets } from '../../lib/agenda-answers.ts';
import {
  directionOfAction,
  type InboxAction,
  type InboxCard,
  SWIPE_SLOP_PX,
  type SwipeDirection,
  swipeIntent,
  swipeMap,
} from '../../lib/agenda-inbox.ts';
import { usePrefersReducedMotion } from '../../shell/bottom-sheet.tsx';

/** How long a committed card takes to leave. The answer is handed over at once; this is only the look. */
const FLY_MS = 220;

/** The least the top card is given, so a short screen still shows its head and its answer bar. */
const MIN_ROOM_PX = 320;
/** Breathing room under the card, beyond the peeking cards' own padding. */
const ROOM_MARGIN_PX = 8;

/**
 * How tall the top card may be: from the deck's top edge to the bottom of what the reader can see,
 * less whatever the host draws under the deck (the inbox's hint) and the peeks' padding — never less
 * than {@link MIN_ROOM_PX}. Pure, so the arithmetic is proved without a layout engine.
 */
export const deckRoom = (deckTop: number, visibleBottom: number, below: number, peekPadding: number): number =>
  Math.max(MIN_ROOM_PX, Math.floor(visibleBottom - deckTop - below - peekPadding - ROOM_MARGIN_PX));

/** The bottom edge of what the reader can see of `element`: its nearest scrolling ancestor, else the window. */
const visibleBottomOf = (element: HTMLElement): number => {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return parent.getBoundingClientRect().bottom;
  }
  return window.visualViewport?.height ?? window.innerHeight;
};

/** The room a mounted deck has, read off the layout. */
const roomOf = (element: HTMLElement): number => {
  const below = element.nextElementSibling?.getBoundingClientRect().height ?? 0;
  const padding = Number.parseFloat(getComputedStyle(element).paddingBottom) || 0;
  return deckRoom(element.getBoundingClientRect().top, visibleBottomOf(element), below, padding);
};

/**
 * The room the deck has, measured, as the `--deck-room` its top card is capped by — so the card's
 * detail grows into the screen it has rather than a guess at it. Re-measured when the window resizes
 * and when a new card comes on top.
 */
const useDeckRoom = (deck: { readonly current: HTMLDivElement | null }, topKey: string | undefined): number | null => {
  const [room, setRoom] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new card on top is a reason to measure again
  useEffect(() => {
    const measure = (): void => {
      const element = deck.current;
      if (element !== null) setRoom(roomOf(element));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [topKey]);
  return room;
};

/** How many cards peek out behind the top one. */
const PEEKS = 2;

const KEY_DIRECTION: Readonly<Record<string, SwipeDirection>> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowUp: 'up',
};

const DIRECTION_WORD: Readonly<Record<SwipeDirection, string>> = {
  right: 'right',
  left: 'left',
  up: 'up',
};

/** The direction a key points, or `null` for a key that is not one of the three arrows. */
export const agendaKeyDirection = (key: string): SwipeDirection | null => KEY_DIRECTION[key] ?? null;

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

interface AgendaCardFrameProps {
  readonly card: InboxCard;
  readonly targets: SwipeTargets;
  readonly onArrow: (direction: SwipeDirection) => void;
  readonly children: ReactNode;
}

/**
 * A card as something the keyboard can answer: focusable, described by what its arrows do, and taking
 * ←/→/↑ for the answer in that direction — only when the CARD is focused, never while focus is in a
 * field or on one of its buttons, where the arrows already mean something.
 */
function AgendaCardFrame({ card, targets, onArrow, children }: AgendaCardFrameProps) {
  const hintId = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    const direction = agendaKeyDirection(event.key);
    if (direction === null || targets[direction] === undefined) return;
    event.preventDefault();
    onArrow(direction);
  };
  return (
    <section
      aria-describedby={hintId}
      aria-label={agendaTitle(card.item)}
      className="fy-attn-frame"
      data-agenda-frame={card.item.id}
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
  /** Where it began in a detail that scrolls, or `null` outside one: see {@link verticalTargets}. */
  readonly scroll: ScrollStart | null;
}

interface Gesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  readonly scroll: ScrollStart | null;
  moved: boolean;
  dx: number;
  dy: number;
}

interface Leaving {
  readonly card: InboxCard;
  readonly direction: SwipeDirection;
  readonly from: Drag;
}

/** Where a drag of `(dx, dy)` draws the card: it follows sideways, and up or down only when that means something. */
export const dragOffset = (dx: number, dy: number, targets: SwipeTargets): Drag => ({
  dx,
  dy: dy >= 0 ? 0 : targets.up === undefined ? dy * 0.2 : dy,
});

/** A drag that began inside the card's detail while it overflowed: whether the detail sat at its top, or its bottom. */
export interface ScrollStart {
  readonly atTop: boolean;
  readonly atBottom: boolean;
}

/**
 * The card's swipe targets for a drag that began at `scroll` — `null` for the header, the title or the answer
 * bar, which keep every target. Inside a detail that overflows, a vertical drag is the reader scrolling,
 * except where the detail cannot scroll any further that way: ↑ stays only when it was at its bottom. The sideways answers always stay; a detail never scrolls sideways.
 */
export const verticalTargets = (targets: SwipeTargets, scroll: ScrollStart | null): SwipeTargets => {
  if (scroll === null) return targets;
  const { up, ...sideways } = targets;
  return {
    ...sideways,
    ...(scroll.atBottom && up !== undefined ? { up } : {}),
  };
};

/** Where a pointer went down in the card's detail, or `null` when it was outside it or the detail fits whole. */
export const scrollStartOf = (target: EventTarget | null): ScrollStart | null => {
  const scroller = target instanceof Element ? target.closest<HTMLElement>('[data-agenda-scroll]') : null;
  if (scroller === null || scroller.scrollHeight <= scroller.clientHeight + 1) return null;
  return {
    atTop: scroller.scrollTop <= 1,
    atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1,
  };
};

/** A drag never starts where the reader types. */
const startsInField = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('textarea, input, select, [contenteditable="true"]') !== null;

/**
 * A SWIPE STARTS ONLY FROM THE CARD'S HEAD — its header and its title, the part every card has in the same
 * place. The detail is for scrolling and the answer bar for pressing, so neither ever turns into a swipe.
 */
const startsInHandle = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('.fy-attn-card__meta, [data-agenda-title]') !== null;

export interface AgendaSwipeDeckProps {
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

export function AgendaSwipeDeck({ cards, renderCard, onAct, reducedMotion }: AgendaSwipeDeckProps) {
  const reduced = useReducedMotion(reducedMotion);
  const [drag, setDrag] = useState<RawDrag | null>(null);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const deck = useRef<HTMLDivElement | null>(null);
  /** Focus was in the deck when a card left: the next card takes it, so the keyboard keeps its place. */
  const refocus = useRef(false);
  const swallowClick = useRef(false);
  const top = cards[0];
  const targets: SwipeTargets = top === undefined ? {} : swipeTargets(top.item);

  const topKey = top?.key;
  const room = useDeckRoom(deck, topKey);
  // A new card on top starts with no drag — the old one's must never carry over — and
  // takes the focus the card it replaced had.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the card on top changing is the only trigger
  useEffect(() => {
    gesture.current = null;
    setDrag(null);
    if (!refocus.current) return;
    // The last card leaving forgets the focus too: a card arriving later must not steal it.
    refocus.current = false;
    if (topKey === undefined) return;
    deck.current?.querySelector<HTMLElement>('.fy-attn-deck__top [data-agenda-frame]')?.focus();
  }, [topKey]);

  useEffect(() => {
    if (leaving === null) return;
    const timer = setTimeout(() => setLeaving(null), FLY_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const answer = (card: InboxCard, action: InboxAction, from: Drag): void => {
    const direction = directionOfAction(swipeMap(card.item), action);
    refocus.current = deck.current?.contains(document.activeElement) === true;
    gesture.current = null;
    setDrag(null);
    if (!reduced && direction !== null) setLeaving({ card, direction, from });
    onAct(card, action);
  };

  /** A swipe or arrow toward `direction`: its answer goes; a "Needs changes" has none, so the card springs back. */
  const give = (card: InboxCard, direction: SwipeDirection, from: Drag): void => {
    const target = targets[direction];
    // Both callers give only a direction the card takes; the guard keeps a future caller from sending
    // nothing, and a "Needs changes" (written in the message box) has no action to send.
    if (target === undefined || target.action === null) {
      setDrag(null);
      return;
    }
    answer(card, target.action, from);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    swallowClick.current = false;
    if (
      top === undefined ||
      (event.pointerType === 'mouse' && event.button !== 0) ||
      startsInField(event.target) ||
      !startsInHandle(event.target)
    )
      return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: event.currentTarget.getBoundingClientRect().width,
      scroll: scrollStartOf(event.target),
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
    setDrag({ dx: current.dx, dy: current.dy, width: current.width, scroll: current.scroll });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId || top === undefined) return;
    gesture.current = null;
    if (!current.moved) return;
    swallowClick.current = true;
    const live = verticalTargets(targets, current.scroll);
    const intent = swipeIntent(current.dx, current.dy, current.width, live);
    if (intent.committed && intent.direction !== null)
      give(top, intent.direction, dragOffset(current.dx, current.dy, live));
    else setDrag(null);
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDrag(null);
  };

  if (top === undefined && leaving === null) return null;

  const live = drag === null ? targets : verticalTargets(targets, drag.scroll);
  const intent = drag === null ? null : swipeIntent(drag.dx, drag.dy, drag.width, live);
  const offset = drag === null ? null : dragOffset(drag.dx, drag.dy, live);
  const stamp: SwipeTarget | undefined = intent?.direction == null ? undefined : live[intent.direction];
  const peeks = cards.slice(1, 1 + PEEKS);

  return (
    <div
      className="fy-attn-deck"
      data-agenda-deck=""
      data-reduced-motion={reduced || undefined}
      ref={deck}
      style={room === null ? undefined : ({ '--deck-room': `${room}px` } as CSSProperties)}
    >
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
          data-has-up={targets.up === undefined ? undefined : ''}
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
          <AgendaCardFrame card={top} onArrow={direction => give(top, direction, { dx: 0, dy: 0 })} targets={targets}>
            {renderCard(top, action => answer(top, action, { dx: 0, dy: 0 }))}
          </AgendaCardFrame>
          {intent === null || intent.direction === null ? null : (
            <div
              aria-hidden="true"
              className="fy-attn-deck__stamp"
              data-agenda-stamp={intent.direction}
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
