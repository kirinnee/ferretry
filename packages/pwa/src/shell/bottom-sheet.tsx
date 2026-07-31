/**
 * The shared focus-trapped, swipe-dismissable bottom sheet — the app's ONE
 * modal shell on a phone. Ported from kteam's `SessionDetails.tsx`, where it was
 * first written; every other sheet (settings, the side-pane tab switcher, the
 * rename and pin flows) composes this exact primitive instead of growing a
 * second, subtly different modal.
 */

import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import { cn } from '../lib/class-names.ts';

const SHEET_TRANSITION_MS = 200;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** Past this the sheet is dismissed on release. */
const SWIPE_CLOSE_FRACTION = 0.25;
/** A flick: short travel, high speed. */
const SWIPE_FLICK_DISTANCE = 12;
const SWIPE_FLICK_VELOCITY = 0.65;
/** Below this the gesture is a tap, and the handle's click still closes. */
const SWIPE_DRAG_SLOP = 4;

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION).matches === true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(REDUCED_MOTION);
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return reduced;
}

interface SwipeGesture {
  pointerId: number;
  startY: number;
  lastY: number;
  lastAt: number;
  distance: number;
  velocity: number;
}

export interface BottomSheetProps {
  readonly id: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly labelledBy?: string;
  readonly ariaLabel?: string;
  readonly closeLabel: string;
  readonly children: ReactNode;
  readonly panelClassName?: string;
  readonly maxHeight?: string;
  /** ONE fixed height instead of sizing to the content. A tabbed sheet must not
   *  change height when the reader switches tabs — the tab bar they just tapped
   *  would relocate under their thumb — so the tabbed caller pins the sheet to
   *  its ceiling and lets only the content area scroll. Callers whose content is
   *  a single fixed form keep the shrink-to-fit default. */
  readonly height?: string;
  /** Settings can replace details during its closing frame, so it paints one
   *  layer higher while still using exactly the same sheet machinery. */
  readonly zIndexClass?: string;
}

export function BottomSheet({
  id,
  open,
  onClose,
  labelledBy,
  ariaLabel,
  closeLabel,
  children,
  panelClassName,
  maxHeight = 'min(72dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))',
  height,
  zIndexClass = 'z-40',
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const swipeRef = useRef<SwipeGesture | null>(null);
  const suppressHandleClick = useRef(false);
  const reducedMotion = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const [dragY, setDragY] = useState<number | null>(null);

  // `open || mounted` is load-bearing: the first open renders the panel before
  // useDialogFocus tries to focus it, while `mounted` alone keeps the DOM around
  // for the close slide. Reduced motion removes it in the closing layout pass.
  const rendered = open || mounted;
  useLayoutEffect(() => {
    let frame: number | undefined;
    swipeRef.current = null;
    setDragY(null);
    if (open) {
      setMounted(true);
      suppressHandleClick.current = false;
      if (reducedMotion) setEntered(true);
      else {
        setEntered(false);
        frame = requestAnimationFrame(() => setEntered(true));
      }
    } else {
      setEntered(false);
      if (reducedMotion) setMounted(false);
    }
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [open, reducedMotion]);

  useEffect(() => {
    if (open || !mounted || reducedMotion) return;
    const timeout = window.setTimeout(() => setMounted(false), SHEET_TRANSITION_MS);
    return () => window.clearTimeout(timeout);
  }, [open, mounted, reducedMotion]);

  // Losing the window mid-drag must snap the sheet back rather than leaving a
  // stale offset for the next open. Pointer capture itself is released by the
  // browser; this only clears our gesture state.
  useEffect(() => {
    const cancelSwipe = () => {
      if (!swipeRef.current) return;
      swipeRef.current = null;
      suppressHandleClick.current = true;
      setDragY(null);
    };
    window.addEventListener('blur', cancelSwipe);
    return () => window.removeEventListener('blur', cancelSwipe);
  }, []);

  const { onKeyDown } = useDialogFocus(open, panelRef, onClose);

  const beginSwipe = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (!open || event.button !== 0) return;
    swipeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      lastAt: event.timeStamp,
      distance: 0,
      velocity: 0,
    };
    suppressHandleClick.current = false;
    setDragY(0);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveSwipe = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const gesture = swipeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - gesture.startY);
    const elapsed = Math.max(1, event.timeStamp - gesture.lastAt);
    gesture.velocity = (event.clientY - gesture.lastY) / elapsed;
    gesture.lastY = event.clientY;
    gesture.lastAt = event.timeStamp;
    gesture.distance = distance;
    if (distance > SWIPE_DRAG_SLOP) suppressHandleClick.current = true;
    setDragY(distance);
  };

  const endSwipe = (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean): void => {
    const gesture = swipeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    swipeRef.current = null;

    const threshold = (panelRef.current?.getBoundingClientRect().height ?? 0) * SWIPE_CLOSE_FRACTION;
    const shouldClose =
      !cancelled &&
      (gesture.distance >= threshold ||
        (gesture.distance > SWIPE_FLICK_DISTANCE && gesture.velocity > SWIPE_FLICK_VELOCITY));
    setDragY(null);
    if (shouldClose) onClose();
  };

  const clickHandle = (): void => {
    if (suppressHandleClick.current) {
      suppressHandleClick.current = false;
      return;
    }
    onClose();
  };

  if (!rendered) return null;

  const sheetTransform =
    dragY === null ? (open && entered ? 'translateY(0)' : 'translateY(100%)') : `translateY(${dragY}px)`;

  return (
    <div
      data-bottom-sheet={id}
      className={cn(
        'kt-overlay fixed inset-x-0 flex flex-col justify-end',
        zIndexClass,
        !open && 'pointer-events-none',
      )}
      aria-hidden={open ? undefined : true}
    >
      {/* Backdrop. A plain button so a click OR a keyboard activation dismisses,
          and screen readers are told what it does rather than meeting a div. */}
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        disabled={!open}
        tabIndex={open ? 0 : -1}
        className={cn(
          'absolute inset-0 cursor-default bg-scrim transition-opacity duration-200 motion-reduce:transition-none',
          open && entered ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        id={id}
        ref={panelRef}
        // kteam dropped the role while closing. The panel is already removed
        // from the accessibility tree during the slide-out — `inert` here and
        // `aria-hidden` on the wrapper — so a stable role is equivalent for a
        // reader and keeps the element's ARIA attributes and its keyboard
        // handler on an element that actually has a role.
        role="dialog"
        aria-modal={open ? true : undefined}
        aria-labelledby={open ? labelledBy : undefined}
        aria-label={open && !labelledBy ? ariaLabel : undefined}
        tabIndex={open ? -1 : undefined}
        inert={open ? undefined : true}
        onKeyDown={open ? onKeyDown : undefined}
        onTransitionEnd={event => {
          if (!open && event.target === event.currentTarget && event.propertyName === 'transform') setMounted(false);
        }}
        className={cn(
          'kt-panel kt-sheet relative z-10 flex w-full flex-col font-ui will-change-transform',
          panelClassName,
          dragY === null && 'transition-transform duration-200 ease-out motion-reduce:transition-none',
        )}
        style={{
          maxHeight,
          // `height` (when given) still yields to `maxHeight`: the fixed height
          // is the tall-end pick and maxHeight is the keyboard-safe ceiling, so
          // an open keyboard shrinks the sheet rather than letting it run
          // underneath.
          ...(height ? { height } : {}),
          transform: sheetTransform,
        }}
      >
        {/* The handle is both the visible dismissal affordance and the ONLY
            swipe surface. Its own touch-action prevents gesture arbitration;
            the content scroller below never sees these pointer handlers. */}
        <button
          type="button"
          aria-label={closeLabel}
          data-sheet-swipe="supported"
          disabled={!open}
          onClick={clickHandle}
          onPointerDown={beginSwipe}
          onPointerMove={moveSwipe}
          onPointerUp={event => endSwipe(event, false)}
          onPointerCancel={event => endSwipe(event, true)}
          className="group mx-auto flex min-h-[44px] w-20 shrink-0 touch-none cursor-grab items-center justify-center py-3 active:cursor-grabbing"
          title="Close, or swipe down"
        >
          <span
            className="block h-1 w-12 rounded-full bg-border-strong transition-colors group-hover:bg-fg-soft"
            aria-hidden="true"
          />
        </button>
        {children}
      </div>
    </div>
  );
}
