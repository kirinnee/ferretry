/**
 * Swipe left or right on the phone workspace's content to move between tabs.
 *
 * Passive touch listeners on the content root, the same shape as the pull-to-
 * palette gesture: nothing is ever cancelled, so a gesture this hook declines is
 * exactly the scroll the browser would have done anyway. The thresholds live in
 * `tab-swipe-model.ts`; this file only decides which gestures are ours at all.
 */

import { useEffect, useRef } from 'react';
import { advanceTabSwipe, beginTabSwipe, resolveTabSwipe, type TabSwipe } from './tab-swipe-model.ts';

/** Mark a surface that owns its own sideways gestures (a carousel, a diff, a canvas). */
export const TAB_SWIPE_IGNORE_ATTR = 'data-tab-swipe-ignore';

/** Does this element itself scroll sideways right now? Both halves, as for vertical pull. */
const scrollsHorizontally = (element: HTMLElement, overflowX: string): boolean =>
  element.scrollWidth > element.clientWidth && (overflowX === 'auto' || overflowX === 'scroll');

/**
 * Is a gesture starting on this node somebody else's? Walked outwards from the
 * touched node to the root: a horizontally scrolling block (a wide code line, a
 * table), an opt-out, or a `touch-action: none` surface (the remote browser, a
 * sheet handle) owns the movement, and so does a live text selection — the
 * reader is extending it, which in a terminal is the only way to copy.
 */
export const tabSwipeBlocked = (target: EventTarget | null, root: HTMLElement): boolean => {
  const touched = target as Node | null;
  if (touched === null || !root.contains(touched)) return true;
  const selection = root.ownerDocument.getSelection();
  if (selection !== null && !selection.isCollapsed) return true;
  let element: HTMLElement | null = touched instanceof HTMLElement ? touched : touched.parentElement;
  while (element !== null && element !== root) {
    if (element.hasAttribute(TAB_SWIPE_IGNORE_ATTR)) return true;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (style?.touchAction === 'none') return true;
    if (scrollsHorizontally(element, style?.overflowX ?? '')) return true;
    element = element.parentElement;
  }
  return false;
};

export function useTabSwipe(
  rootRef: { readonly current: HTMLElement | null },
  { enabled, onSwipe }: { readonly enabled: boolean; readonly onSwipe: (direction: 'next' | 'previous') => void },
): void {
  const swipeRef = useRef(onSwipe);
  swipeRef.current = onSwipe;

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || root === null) return undefined;
    let swipe: TabSwipe | null = null;
    const onStart = (event: TouchEvent): void => {
      const touch = event.touches[0];
      swipe =
        event.touches.length === 1 && touch !== undefined && !tabSwipeBlocked(event.target, root)
          ? beginTabSwipe({ x: touch.clientX, y: touch.clientY, at: event.timeStamp })
          : null;
    };
    const onMove = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (swipe === null) return;
      // A second finger is a pinch, never a swipe.
      if (event.touches.length !== 1 || touch === undefined) {
        swipe = null;
        return;
      }
      swipe = advanceTabSwipe(swipe, { x: touch.clientX, y: touch.clientY, at: event.timeStamp });
    };
    const onEnd = (): void => {
      const direction = swipe === null ? null : resolveTabSwipe(swipe);
      swipe = null;
      if (direction !== null) swipeRef.current(direction);
    };
    const onCancel = (): void => {
      swipe = null;
    };
    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: true });
    root.addEventListener('touchend', onEnd, { passive: true });
    root.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onCancel);
    };
  }, [enabled, rootRef]);
}
