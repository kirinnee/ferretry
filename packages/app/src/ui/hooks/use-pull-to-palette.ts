import { useEffect, useRef, useState } from 'react';

/**
 * Names a scroller explicitly, for a page whose scroll port this hook could not
 * otherwise recognise. It is an OVERRIDE, not the mechanism: a page that has to
 * be listed to be reachable is a page the next author forgets.
 */
export const PULL_TO_PALETTE_ATTR = 'data-pull-to-palette';

/**
 * Refuses the gesture for a scroller that already owns it. A transcript loads
 * older messages on the same downward movement, so opening the finder there
 * would take a reader's history away from them.
 *
 * The opt-OUT is the closed list, deliberately. There are a handful of surfaces
 * where pulling down already means something; every other page in the app, now
 * and later, gets the finder without being enumerated anywhere.
 */
export const PULL_TO_PALETTE_IGNORE_ATTR = 'data-pull-to-palette-ignore';

export const PALETTE_PULL_THRESHOLD_PX = 96;

export interface PalettePull {
  readonly armed: boolean;
  readonly startY: number;
  readonly distance: number;
}

export const NO_PULL: PalettePull = { armed: false, startY: 0, distance: 0 };

export const beginPull = ({
  touches,
  scrollTop,
  clientY,
}: {
  touches: number;
  scrollTop: number;
  clientY: number;
}): PalettePull => {
  // WebKit may expose a negative value while rubber-banding at the top. That is
  // still the top edge; only a positive value means the gesture began within
  // scrollable content and must remain native scrolling.
  if (touches !== 1 || scrollTop > 0) return NO_PULL;
  return { armed: true, startY: clientY, distance: 0 };
};

export const advancePull = (
  state: PalettePull,
  { touches, scrollTop, clientY }: { touches: number; scrollTop: number; clientY: number },
): PalettePull => {
  if (!state.armed || touches !== 1 || scrollTop > 0) return NO_PULL;
  const travel = clientY - state.startY;
  return { armed: true, startY: state.startY, distance: travel > 0 ? travel : 0 };
};

export const endPull = (state: PalettePull, threshold = PALETTE_PULL_THRESHOLD_PX): boolean =>
  state.armed && state.distance >= threshold;

export const palettePullProgress = (distance: number, threshold = PALETTE_PULL_THRESHOLD_PX): number => {
  if (!(distance > 0) || !(threshold > 0)) return 0;
  return Math.min(1, distance / threshold);
};

export interface PullToPalette {
  readonly distance: number;
  readonly progress: number;
  readonly armed: boolean;
}

/**
 * Does this element itself scroll vertically right now?
 *
 * Both halves are required. Overflowing content alone is true of any ordinary
 * block that happens to be taller than its box, and a scroll-y style alone is
 * true of a pane with nothing in it yet — neither is the element whose
 * `scrollTop` decides whether the reader is at the top of what they are reading.
 */
const scrollsVertically = (element: HTMLElement, overflowY: string): boolean => {
  if (element.scrollHeight <= element.clientHeight) return false;
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
};

/**
 * The scroll port this touch began in, or `null` when the gesture is not ours.
 *
 * Walked from the touched node OUTWARDS so the nearest answer wins, and stopped
 * at the shell root so a scroller belonging to the chrome above it is never
 * mistaken for the page's own. An opt-out or `touch-action: none` owner met on
 * the way refuses the whole gesture rather than continuing to look for an outer
 * scroller, because the reader's finger is inside a surface that already owns
 * this movement (a sheet handle, graph pan, or remote browser, for example).
 *
 * Reaching the root without finding a scroll port is the ANSWER, not a failure:
 * a page with nothing to scroll cannot be scrolled by pulling down, so the
 * movement is unambiguous and the root stands in as a port whose `scrollTop` is
 * always zero. That is what makes every destination pullable without a list.
 */
export const pullScrollerOf = (target: EventTarget | null, root: HTMLElement): HTMLElement | null => {
  const touched = target as Element | null;
  if (touched === null || typeof touched.closest !== 'function' || !root.contains(touched)) return null;
  let element: HTMLElement | null = touched as HTMLElement;
  while (element !== null) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (element.hasAttribute(PULL_TO_PALETTE_IGNORE_ATTR)) return null;
    // Custom drag surfaces use this browser contract to keep native panning out
    // of their pointer stream. The global pull must stay out for the same reason.
    if (style?.touchAction === 'none') return null;
    if (element.hasAttribute(PULL_TO_PALETTE_ATTR)) return element;
    if (scrollsVertically(element, style?.overflowY ?? '')) return element;
    if (element === root) break;
    element = element.parentElement;
  }
  return root;
};

/**
 * Delegated passive pull handling for every page scroller under one shell root.
 *
 * One listener set on the root, so a destination added later needs no wiring:
 * the scroll port is discovered from the touch itself. Listeners are passive and
 * nothing is ever cancelled, so a movement this hook declines stays exactly the
 * scroll the browser would have done.
 */
export function usePullToPalette(
  rootRef: { current: HTMLElement | null },
  {
    enabled,
    onOpen,
    threshold = PALETTE_PULL_THRESHOLD_PX,
  }: { readonly enabled: boolean; readonly onOpen: () => void; readonly threshold?: number },
): PullToPalette {
  const [distance, setDistance] = useState(0);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || root === null) {
      setDistance(0);
      return undefined;
    }
    let pull = NO_PULL;
    let scroller: HTMLElement | null = null;
    const reset = (): void => {
      pull = NO_PULL;
      scroller = null;
      setDistance(0);
    };
    const onStart = (event: TouchEvent): void => {
      scroller = pullScrollerOf(event.target, root);
      const touch = event.touches[0];
      if (scroller === null || touch === undefined) {
        reset();
        return;
      }
      pull = beginPull({ touches: event.touches.length, scrollTop: scroller.scrollTop, clientY: touch.clientY });
      setDistance(pull.distance);
    };
    const onMove = (event: TouchEvent): void => {
      if (!pull.armed || scroller === null) return;
      const touch = event.touches[0];
      if (touch === undefined) {
        reset();
        return;
      }
      pull = advancePull(pull, {
        touches: event.touches.length,
        scrollTop: scroller.scrollTop,
        clientY: touch.clientY,
      });
      setDistance(pull.distance);
    };
    const onEnd = (): void => {
      const opens = endPull(pull, threshold);
      reset();
      if (opens) openRef.current();
    };
    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: true });
    root.addEventListener('touchend', onEnd, { passive: true });
    root.addEventListener('touchcancel', reset, { passive: true });
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', reset);
      setDistance(0);
    };
  }, [enabled, rootRef, threshold]);

  return { distance, progress: palettePullProgress(distance, threshold), armed: distance >= threshold };
}
