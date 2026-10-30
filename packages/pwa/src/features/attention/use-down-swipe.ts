/**
 * THE ↓ SWIPE THAT GOES BACK TO THE CHAT, on touch: drag down from the item view's head or its answer area, past
 * the distance an answer swipe needs (`swipeThreshold`), mostly straight. Esc, ↓ and ✕ do the same elsewhere.
 */

import { type PointerEvent, useRef } from 'react';
import { swipeThreshold } from '../../lib/attention-inbox.ts';

/** A drag that is a clear, mostly vertical pull downward. */
export const isDownSwipe = (dx: number, dy: number, width: number): boolean =>
  dy > Math.abs(dx) && dy >= swipeThreshold(width);

interface Start {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

/** Pointer handlers for a region that closes the view when it is pulled down. Mouse never swipes. */
export function useDownSwipe(onClose: () => void, enabled: boolean) {
  const start = useRef<Start | null>(null);
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>): void => {
      if (!enabled || event.pointerType === 'mouse') return;
      start.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerUp: (event: PointerEvent<HTMLElement>): void => {
      const began = start.current;
      if (began === null || began.pointerId !== event.pointerId) return;
      start.current = null;
      if (
        isDownSwipe(event.clientX - began.x, event.clientY - began.y, event.currentTarget.getBoundingClientRect().width)
      ) {
        onClose();
      }
    },
    onPointerCancel: (): void => {
      start.current = null;
    },
  };
}
