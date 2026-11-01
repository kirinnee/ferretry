/**
 * THE PHONE'S AGENDA DECK: the newest card on top, draggable; the next ones peeking out behind it.
 *
 * A swipe is an answer, so it is held to the same rules a button is, and then some:
 *
 * - THE MAPPING IS THE CARD'S OWN ANSWERS (`swipeTargets`), never a second one: left, up and right each
 *   give the answer the card put in that direction. A direction with no answer commits nothing. While the
 *   card is dragged it follows the finger; nothing is drawn over it naming the answer (the owner wants no teaching
 *   text on the card) — what letting go would do is kept on the card as `data-swipe-*` attributes. A review's
 *   "Needs changes" is written in the message box, so it has no swipe: that drag springs back.
 * - IT COMMITS ONLY PAST THE THRESHOLD (`swipeIntent(...).committed`). Short of it the card springs back
 *   and nothing is sent; past it the card flies off and the answer is handed to `onAct` — which, in the
 *   inbox, holds it for the undo window (`DeferredAgendaActions`) rather than posting it.
 * - DOWN IS SKIP, as on every swipeable card: a drag down past the threshold moves to the next card (`onSkip`) and the card
 *   follows it down. Nothing is answered, dismissed or sent to `onAct`. "Not needed" is only its own button, and it is
 *   never a swipe. Where the deck cannot skip (`onSkip` absent) the card does not follow a downward drag and the
 *   browser keeps it as a scroll.
 * - THE WHOLE CARD SWIPES, BY TOUCH ONLY. A touch may start anywhere on the card ({@link ./agenda-swipe-gesture.ts}):
 *   the direction is decided after 10px and kept. Sideways is a swipe (left and right answers). Up or down from the
 *   body is the reader scrolling and is handed to the browser (`touch-action: pan-y`); only the card's head, which
 *   does not scroll, keeps the up answer and Skip. A mouse drag is the reader selecting text, never a swipe; a
 *   touch that starts on a link, a button or a field, or inside something that scrolls sideways (a table), is that
 *   element's, never the deck's.
 * - A SCROLL IS NEVER A SWIPE. A drag that moved swallows the click it ends in, so a swipe that ends over a button
 *   does not also press it.
 * - KEYBOARD AND SCREEN-READER PARITY: the same answers are the card's own buttons, and a focused card
 *   takes ←, → and ↑ for the mapped answer ({@link AgendaCardFrame}), said in an sr-only hint.
 * - REDUCED MOTION (the OS preference, or Settings › Appearance › Motion) drops the fly-off and the
 *   spring: the card is simply gone, or simply back.
 */

import { agendaTitle } from '@ferretry/protocol';
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
  type InboxAction,
  type InboxCard,
  SWIPE_SLOP_PX,
  type SwipeDirection,
  type SwipeIntent,
  swipeIntent,
  swipeThreshold,
} from '../../lib/agenda-inbox.ts';
import { usePrefersReducedMotion } from '../../shell/bottom-sheet.tsx';
import {
  isLongPress,
  isTouch,
  lockOf,
  startsInHead,
  startsInSelection,
  startsInSidewaysScroller,
  startsOnInteractive,
} from './agenda-swipe-gesture.ts';
import { SwipeReveal } from './swipe-reveal.tsx';

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
const roomOf = (element: HTMLElement, reserve: number): number => {
  const below = element.nextElementSibling?.getBoundingClientRect().height ?? 0;
  const padding = Number.parseFloat(getComputedStyle(element).paddingBottom) || 0;
  return deckRoom(element.getBoundingClientRect().top, visibleBottomOf(element), below, padding + reserve);
};

/**
 * The room the deck has, measured, as the `--deck-room` its top card is capped by — so the card's
 * detail grows into the screen it has rather than a guess at it. Re-measured when the window resizes,
 * when a new card comes on top and when what is drawn under the deck changes size.
 */
export const useDeckRoom = (
  deck: { readonly current: HTMLElement | null },
  topKey: string | undefined,
  reserve = 0,
): number | null => {
  const [room, setRoom] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new card on top is a reason to measure again
  useEffect(() => {
    const measure = (): void => {
      const element = deck.current;
      if (element !== null) setRoom(roomOf(element, reserve));
    };
    measure();
    window.addEventListener('resize', measure);
    // What the host draws under the deck can grow after it (the Inbox's composer arrives once its client is ready,
    // and grows as it is typed in): the card gives up that room rather than pushing it off the screen.
    const below = deck.current?.nextElementSibling;
    const observer =
      below == null || typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    if (observer !== null && below != null) observer.observe(below);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
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

/** A way a card can leave the deck: one of its answers' directions, or down — Skip. */
export type DeckDirection = SwipeDirection | 'down';

/**
 * Reads a drag on a deck that can skip: a mostly-downward drag is Skip (`down`), committed past the same threshold an
 * answer needs; every other drag reads as `swipeIntent` does. Where the deck cannot skip, down is nothing.
 */
export const deckIntent = (
  dx: number,
  dy: number,
  width: number,
  targets: SwipeTargets,
  canDown: boolean,
): Omit<SwipeIntent, 'direction'> & { readonly direction: DeckDirection | null } => {
  if (canDown && dy > Math.abs(dx) && dy >= SWIPE_SLOP_PX) {
    const progress = Math.min(1, dy / swipeThreshold(width));
    return { direction: 'down', progress, committed: progress >= 1 };
  }
  return swipeIntent(dx, dy, width, targets);
};

/** The direction an action leaves in: the one of `targets` that sends it (matched by meaning), else none. */
const directionOf = (targets: SwipeTargets, action: InboxAction): SwipeDirection | null => {
  for (const direction of ['up', 'right', 'left'] as const) {
    const mapped = targets[direction]?.action;
    if (mapped != null && mapped.kind === action.kind && mapped.label === action.label) return direction;
  }
  return null;
};

interface AgendaCardFrameProps {
  readonly card: InboxCard;
  readonly targets: SwipeTargets;
  readonly onArrow: (direction: SwipeDirection) => void;
  /** ↓ on the focused card: Skip. Absent: ↓ is the page's. */
  readonly onDown?: (() => void) | undefined;
  readonly children: ReactNode;
}

/**
 * A card as something the keyboard can answer: focusable, described by what its arrows do, and taking
 * ←/→/↑ for the answer in that direction — only when the CARD is focused, never while focus is in a
 * field or on one of its buttons, where the arrows already mean something.
 */
function AgendaCardFrame({ card, targets, onArrow, onDown, children }: AgendaCardFrameProps) {
  const hintId = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ArrowDown' && onDown !== undefined) {
      event.preventDefault();
      onDown();
      return;
    }
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
        {onDown === undefined ? '' : ' Arrow down: skip.'}
      </span>
    </section>
  );
}

interface Drag {
  readonly dx: number;
  readonly dy: number;
}

/** A drag in progress, as the pointer moved it: raw, before {@link dragOffset} draws it. */
interface RawDrag extends Drag {
  readonly width: number;
  /** Whether it began in the card's head: see {@link bodyTargets}. */
  readonly head: boolean;
}

interface Gesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  readonly head: boolean;
  readonly startedAt: number;
  moved: boolean;
  dx: number;
  dy: number;
}

interface Leaving {
  readonly card: InboxCard;
  readonly direction: DeckDirection;
  readonly from: Drag;
}

/** Where a drag of `(dx, dy)` draws the card: it follows sideways, and up or down only when that means something. */
export const dragOffset = (dx: number, dy: number, targets: SwipeTargets, canDown = false): Drag => ({
  dx,
  dy: dy >= 0 ? (canDown ? dy : 0) : targets.up === undefined ? dy * 0.2 : dy,
});

/**
 * The swipe targets for a drag that began in the card's body: the sideways answers only. Up and down from there
 * are the reader scrolling, so a drag that drifts that way after it locked to sideways never answers up.
 */
export const bodyTargets = (targets: SwipeTargets, head: boolean): SwipeTargets => {
  if (head) return targets;
  const { left, right } = targets;
  return { ...(left === undefined ? {} : { left }), ...(right === undefined ? {} : { right }) };
};

export interface AgendaSwipeDeckProps {
  /** The deck, newest first: the first card is on top. */
  readonly cards: readonly InboxCard[];
  /**
   * Draws one card; `act` is how its own buttons answer it (and fly it off, like a swipe), `skip` how its own
   * Skip tap moves past it (and flies it down) when the deck can skip.
   */
  readonly renderCard: (card: InboxCard, act: (action: InboxAction) => void, skip: () => void) => ReactNode;
  /** An answer the reader gave, by swipe, arrow key or button (↓ is Skip, never an answer). */
  readonly onAct: (card: InboxCard, action: InboxAction) => void;
  /** The reader moved on from the card on top without answering it, by a ↓ swipe, the ↓ key or a tap. Absent: the deck cannot skip. */
  readonly onSkip?: (card: InboxCard) => void;
  /**
   * Regions of the card that answer their own swipes (a touch item view's head and quick-reply row): a drag that
   * starts there is theirs, never also the deck's, so one swipe can never answer or skip twice.
   */
  readonly ownGesturesIn?: string;
  /** Forces reduced motion on or off; the reader's preference otherwise. */
  readonly reducedMotion?: boolean;
}

const NO_ACT = (): void => undefined;

export function AgendaSwipeDeck({
  cards,
  renderCard,
  onAct,
  onSkip,
  ownGesturesIn,
  reducedMotion,
}: AgendaSwipeDeckProps) {
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
  /** ↓ is Skip, and only where the deck can skip. */
  const canDown = onSkip !== undefined;

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
    const direction = directionOf(swipeTargets(card.item), action);
    refocus.current = deck.current?.contains(document.activeElement) === true;
    gesture.current = null;
    setDrag(null);
    if (!reduced && direction !== null) setLeaving({ card, direction, from });
    onAct(card, action);
  };

  /** Skip, by a ↓ swipe, the ↓ key or a tap: the card goes and the next one comes on top; nothing is answered. */
  const skip = (card: InboxCard, from: Drag): void => {
    if (onSkip === undefined) return;
    refocus.current = deck.current?.contains(document.activeElement) === true;
    gesture.current = null;
    setDrag(null);
    if (!reduced) setLeaving({ card, direction: 'down', from });
    onSkip(card);
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
      !isTouch(event) ||
      startsOnInteractive(event.target) ||
      startsInSelection(event.target) ||
      startsInSidewaysScroller(event.target, event.currentTarget) ||
      (ownGesturesIn !== undefined && event.target instanceof Element && event.target.closest(ownGesturesIn) !== null)
    )
      return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: event.currentTarget.getBoundingClientRect().width,
      head: startsInHead(event.target),
      startedAt: event.timeStamp,
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
      const lock = lockOf(current.dx, current.dy);
      if (lock === null) return;
      if (isLongPress(event.timeStamp - current.startedAt)) {
        // Held before it moved: the reader is selecting text, and the browser has this touch.
        gesture.current = null;
        return;
      }
      if (lock === 'vertical' && !current.head) {
        // The body scrolls: the browser has this touch now, and it is never a swipe.
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
    setDrag({ dx: current.dx, dy: current.dy, width: current.width, head: current.head });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId || top === undefined) return;
    gesture.current = null;
    if (!current.moved) return;
    swallowClick.current = true;
    const live = bodyTargets(targets, current.head);
    const downs = canDown && current.head;
    const intent = deckIntent(current.dx, current.dy, current.width, live, downs);
    const from = dragOffset(current.dx, current.dy, live, downs);
    const direction = intent.committed ? intent.direction : null;
    if (direction === 'down') skip(top, from);
    else if (direction !== null) give(top, direction, from);
    else setDrag(null);
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDrag(null);
  };

  if (top === undefined && leaving === null) return null;

  const live = drag === null ? targets : bodyTargets(targets, drag.head);
  const downs = canDown && (drag === null || drag.head);
  const intent = drag === null ? null : deckIntent(drag.dx, drag.dy, drag.width, live, downs);
  const offset = drag === null ? null : dragOffset(drag.dx, drag.dy, live, downs);
  const aim: SwipeTarget | undefined =
    intent?.direction == null
      ? undefined
      : intent.direction === 'down'
        ? { label: 'Skip', action: null }
        : live[intent.direction];
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
            {renderCard(card, NO_ACT, NO_ACT)}
          </div>
        ))
        .reverse()}
      {top === undefined ? null : <SwipeReveal active={intent?.direction === 'down' ? 'down' : null} />}
      {top === undefined ? null : (
        <div
          className="fy-attn-deck__top"
          data-dragging={drag === null ? undefined : ''}
          data-has-up={targets.up === undefined ? undefined : ''}
          data-swipe-direction={intent?.direction ?? undefined}
          // What letting go would do — kept on the card for tests and assistive tech. Only ↓ is also drawn, on the ground
          // the card uncovers ({@link SwipeReveal}); the answers stay unnamed, the card just follows the finger.
          data-swipe-committed={intent?.committed || undefined}
          data-swipe-empty={(intent?.direction != null && aim === undefined) || undefined}
          data-swipe-answer={aim?.label}
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
            // The body scrolls vertically; the head (`touch-action: none` in the CSS) reads its own up and down.
            touchAction: 'pan-y',
            ...(offset === null
              ? {}
              : {
                  transform: `translate3d(${offset.dx}px, ${offset.dy}px, 0) rotate(${(offset.dx / 24).toFixed(2)}deg)`,
                }),
          }}
        >
          <AgendaCardFrame
            card={top}
            onArrow={direction => give(top, direction, { dx: 0, dy: 0 })}
            onDown={canDown ? () => skip(top, { dx: 0, dy: 0 }) : undefined}
            targets={targets}
          >
            {renderCard(
              top,
              action => answer(top, action, { dx: 0, dy: 0 }),
              () => skip(top, { dx: 0, dy: 0 }),
            )}
          </AgendaCardFrame>
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
          {renderCard(leaving.card, NO_ACT, NO_ACT)}
        </div>
      )}
    </div>
  );
}
