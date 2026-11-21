/**
 * THE ANSWER ROW of a screen that asks one question: a quiet way out and the one way on, drawn the same everywhere.
 *
 * On a phone the two answers are stacked, each the full width of the container, the way on above the way out. From the
 * desktop breakpoint they share ONE row across the container's width: the way out at the LEFT end, the way on at the RIGHT
 * end (`justify-content: space-between`), both the same size. A lone primary takes the right end, a lone secondary stays at the left (so it does not jump when the primary arrives). The geometry is
 * `action-row.css`; a caller passes buttons (`kt-btn`) and never sizes or places them, so no page invents its own row.
 *
 * KEYBOARD ORDER IS VISUAL ORDER. A CSS `column-reverse` would put the primary on top while Tab still reached the lower
 * secondary first, so the DOM itself is written in the order the eye reads: primary first while stacked (a phone),
 * secondary first in a row (a desktop). The breakpoint is read here and mirrored by the CSS; where `matchMedia` is
 * missing (a test host) the row is the desktop one.
 */
import { type HTMLAttributes, type ReactNode, useSyncExternalStore } from 'react';
import { cn } from './lib/class-names.ts';

/** The width below which the row stacks. Keep in step with the `min-width: 640px` in `action-row.css`. */
const STACKED_QUERY = '(max-width: 639.98px)';

const mediaList = (): MediaQueryList | undefined =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? undefined
    : window.matchMedia(STACKED_QUERY);

function subscribeStacked(notify: () => void): () => void {
  const list = mediaList();
  list?.addEventListener('change', notify);
  return () => list?.removeEventListener('change', notify);
}

const stackedNow = (): boolean => mediaList()?.matches ?? false;

export interface ActionRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The quiet answer ("Not now", "Back"): the left end on a desktop, below the primary on a phone. */
  readonly secondary?: ReactNode;
  /** The answer that moves on ("Pair this device", "Continue"): the right end on a desktop, on top on a phone. */
  readonly primary?: ReactNode;
}

export function ActionRow({ secondary, primary, className, ...rest }: ActionRowProps) {
  const stacked = useSyncExternalStore(subscribeStacked, stackedNow, () => false);
  return (
    <div
      {...rest}
      className={cn('fy-action-row', primary === undefined && 'fy-action-row--start', className)}
      data-action-row=""
    >
      {stacked ? primary : secondary}
      {stacked ? secondary : primary}
    </div>
  );
}
