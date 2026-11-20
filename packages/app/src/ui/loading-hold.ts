/**
 * THE MINIMUM DISPLAY TIME, FOR A LOADER ITS OWNER MOUNTS DIRECTLY. About 110 call sites write
 * `read.loading ? <Loading kind="page" /> : <Content />`; the moment the read answers, React unmounts the loader, so a loader
 * that had only just faded in was on screen for a few frames (a blink, the very thing the 300 ms threshold is for).
 * CSS cannot keep a node that is gone, so a loader that stood for a wait calls {@link useLoadingHold}: when it unmounts
 * after it became visible but before it has been fully shown for `LOADING_MIN_MS`, it leaves a GHOST, a still copy of
 * itself drawn over the same rectangle for the rest of that time (`loading.css` `.fy-loading-ghost`). Same constants as
 * `useHeldLoading` (`delay + fade + min` from when the loader mounted), so an owner that already holds its loader
 * leaves no ghost, and a loader that unmounts inside the delay was never seen and leaves none either.
 *
 * Not for a loader whose whole subtree is removed with it (a closed sheet, a page left behind): the ghost is only left
 * while the loader's own parent is still in the document.
 */
import { type RefObject, useLayoutEffect, useRef } from 'react';
import { LOADING_DELAY_MS, LOADING_FADE_MS, LOADING_MIN_MS } from './loading-gate.ts';

const LOADING_GHOST_CLASS = 'fy-loading-ghost';

export interface LoadingHold {
  /** How long this loader was held back before showing, in ms (default: the one threshold). */
  readonly delayMs?: number;
  /** The loader REPLACED what was being waited for (a page loader), so its ghost covers that area with the surface behind it. */
  readonly cover?: boolean;
}

/** Keeps the loader in `ref` on screen for its minimum once visible, after its owner unmounts it. Call it in the loader. */
export function useLoadingHold(ref: RefObject<HTMLElement | null>, hold: LoadingHold = {}): void {
  const latest = useRef(hold);
  latest.current = hold;
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    const mounted = performance.now();
    // Only the unmount may leave a ghost (the effect has no dependencies), so the cleanup is the unmount.
    return () => leaveGhost(node, mounted, latest.current);
  }, [ref]);
}

/** The first painted background colour at or above `node`, or null when nothing up the tree paints one. */
function surfaceBehind(node: HTMLElement): string | null {
  for (let at: HTMLElement | null = node.parentElement; at !== null; at = at.parentElement) {
    const colour = getComputedStyle(at).backgroundColor;
    if (colour !== '' && colour !== 'transparent' && colour !== 'rgba(0, 0, 0, 0)') return colour;
  }
  return null;
}

function leaveGhost(node: HTMLElement, mounted: number, hold: LoadingHold): void {
  const delay = hold.delayMs ?? LOADING_DELAY_MS;
  const age = performance.now() - mounted;
  const remaining = delay + LOADING_FADE_MS + LOADING_MIN_MS - age;
  if (age < delay || remaining <= 0) return; // never seen, or already shown long enough
  const parent = node.parentElement;
  const rect = node.getBoundingClientRect();
  if (parent === null || rect.width === 0 || rect.height === 0) return;
  const backdrop = hold.cover === true ? surfaceBehind(node) : null;
  const ghost = node.cloneNode(true) as HTMLElement;
  for (const element of [ghost, ...ghost.querySelectorAll<HTMLElement>('*')]) {
    for (const name of element.getAttributeNames())
      if (name.startsWith('data-') || name === 'id' || name === 'role' || name === 'aria-live')
        element.removeAttribute(name);
  }
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('data-loading-ghost', '');
  ghost.classList.add(LOADING_GHOST_CLASS);
  Object.assign(ghost.style, {
    boxSizing: 'border-box',
    height: `${rect.height}px`,
    left: `${rect.left}px`,
    margin: '0',
    pointerEvents: 'none',
    position: 'fixed',
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    zIndex: '5',
    ...(backdrop === null ? {} : { backgroundColor: backdrop }),
  });
  // After React's commit (and before the next paint): only a loader whose parent stayed has been REPLACED by its answer.
  queueMicrotask(() => {
    if (!parent.isConnected) return;
    parent.appendChild(ghost);
    setTimeout(() => ghost.remove(), remaining);
  });
}
