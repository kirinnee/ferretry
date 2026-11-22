/**
 * THE ANSWER ROW of a screen that asks one question: a quiet way out and the one way on, drawn the same everywhere.
 *
 * On a phone the two answers are stacked, each the full width of the container, the way on above the way out. From the
 * desktop breakpoint they share ONE row across the container's width: the way out at the LEFT end, the way on at the RIGHT
 * end (`justify-content: space-between`), both the same size. A lone primary takes the right end, a lone secondary stays at the left (so it does not jump when the primary arrives). The geometry is
 * `action-row.css`; a caller passes buttons (`kt-btn`) and never sizes or places them, so no page invents its own row.
 *
 * KEYBOARD ORDER IS THE VISUAL ORDER at both sizes, with no `tabindex` and no CSS `order`: the two answers swap places in the
 * DOM when the viewport crosses the breakpoint (phone: the way on first, it is on top; desktop: the way out first, it is at the
 * left). A CSS reversal would have drawn one order and tabbed in the other.
 */
import {
  Fragment,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { cn } from './lib/class-names.ts';

/** The desktop breakpoint of `action-row.css` (its `min-width`); the two must change together. */
const DESKTOP = '(min-width: 640px)';

/**
 * FOCUS FOLLOWS THE ACTION, NOT THE SLOT. The two answers swap places in the DOM when the window crosses the breakpoint. Each is
 * keyed, so React keeps the SAME button for the same answer ("Pair this device" stays "Pair this device") instead of reusing the
 * first slot for whichever answer now sits there; and because moving a focused node can drop focus, the answer that had focus
 * is remembered when the media query changes (before the re-render) and focused again once the swap is drawn.
 */
const subscribeTo = (notify: () => void, held: (focused: Element | null) => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(DESKTOP);
  const onChange = (): void => {
    held(document.activeElement);
    notify();
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};
// Without a window or `matchMedia` (a render on the server, a bare test DOM) the row is the desktop one: way out, then way on.
const isDesktop = (): boolean =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(DESKTOP).matches;

export interface ActionRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The quiet answer ("Not now", "Back"): the left end on a desktop, below the primary on a phone. */
  readonly secondary?: ReactNode;
  /** The answer that moves on ("Pair this device", "Continue"): the right end on a desktop, on top on a phone. */
  readonly primary?: ReactNode;
}

export function ActionRow({ secondary, primary, className, ...rest }: ActionRowProps) {
  const row = useRef<HTMLDivElement>(null);
  const focused = useRef<Element | null>(null);
  const subscribe = useCallback(
    (notify: () => void) =>
      subscribeTo(notify, active => {
        focused.current = active !== null && row.current?.contains(active) === true ? active : null;
      }),
    [],
  );
  const desktop = useSyncExternalStore(subscribe, isDesktop, () => true);
  // After a swap is drawn, give focus back to the answer that had it (moving a DOM node can blur it). It runs after every
  // commit and does nothing unless the media query just remembered an answer, so it needs no dependency of its own.
  useLayoutEffect(() => {
    const held = focused.current;
    focused.current = null;
    if (held instanceof HTMLElement && held.isConnected && document.activeElement !== held)
      held.focus({ preventScroll: true });
  });
  const first = <Fragment key={desktop ? 'secondary' : 'primary'}>{desktop ? secondary : primary}</Fragment>;
  const second = <Fragment key={desktop ? 'primary' : 'secondary'}>{desktop ? primary : secondary}</Fragment>;
  return (
    <div
      {...rest}
      ref={row}
      className={cn('fy-action-row', primary === undefined && 'fy-action-row--start', className)}
      data-action-row=""
    >
      {[first, second]}
    </div>
  );
}
