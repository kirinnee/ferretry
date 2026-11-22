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
import { type HTMLAttributes, type ReactNode, useSyncExternalStore } from 'react';
import { cn } from './lib/class-names.ts';

/** The desktop breakpoint of `action-row.css` (its `min-width`); the two must change together. */
const DESKTOP = '(min-width: 640px)';

const subscribe = (notify: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(DESKTOP);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
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
  const desktop = useSyncExternalStore(subscribe, isDesktop, () => true);
  return (
    <div
      {...rest}
      className={cn('fy-action-row', primary === undefined && 'fy-action-row--start', className)}
      data-action-row=""
    >
      {desktop ? secondary : primary}
      {desktop ? primary : secondary}
    </div>
  );
}
