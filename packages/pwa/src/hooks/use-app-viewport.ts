/**
 * Keep the fixed application shell aligned with the visual viewport.
 *
 * iOS can pan a `100dvh` fixed shell above its software keyboard without
 * resizing it.  The stylesheet already consumes these properties, so this
 * module is the sole producer of `--app-h`, `--app-top`, `--kb-h`, and the
 * `data-keyboard` state observed by `useKeyboardOpen`. `--app-h` / `--app-top`
 * exist only while that keyboard is up; at rest every reader falls back to
 * `100dvh` / 0.
 */

import { useEffect } from 'react';

import { DRAWER_MAX } from './use-layout-mode.ts';
import { KEYBOARD_ATTRIBUTE } from './use-keyboard-open.ts';

export const KEYBOARD_MIN_PX = 120;

export interface ViewportMetrics {
  readonly height: number;
  readonly offsetTop: number;
}

export interface AppViewportEnvironment {
  readonly root: HTMLElement;
  readonly document: {
    readonly activeElement: Element | null;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
  readonly innerWidth: () => number;
  readonly innerHeight: () => number;
  readonly scroll: () => Readonly<{ x: number; y: number }>;
  readonly scrollTo: (x: number, y: number) => void;
  readonly visualViewport: {
    readonly read: () => ViewportMetrics | null;
    readonly addEventListener: (type: 'resize' | 'scroll', listener: () => void) => void;
    readonly removeEventListener: (type: 'resize' | 'scroll', listener: () => void) => void;
  } | null;
  readonly coarsePointer: () => boolean;
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (id: number) => void;
  readonly addWindowListener: (type: 'resize' | 'orientationchange', listener: () => void) => void;
  readonly removeWindowListener: (type: 'resize' | 'orientationchange', listener: () => void) => void;
  /** Bring a focused field back into view once the keyboard has shrunk the shell ({@link revealInScroller}). */
  readonly reveal: (element: Element) => void;
}

const isTextEntry = (element: Element | null): boolean => {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable || element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  return !['button', 'checkbox', 'radio', 'range', 'submit'].includes((element as HTMLInputElement).type);
};

/** Room left between a revealed field and its scroller's edge, so its label or border is not on the edge. */
export const REVEAL_MARGIN_PX = 16;

/**
 * Scrolls the field's SCROLLERS — every `auto`/`scroll` ancestor, innermost first — until the field is inside
 * each of them. A box that clips without scrolling is passed over.
 *
 * Not `scrollIntoView`: that also scrolls every `overflow: hidden` ancestor — the fixed shell, the session's
 * column — and a shell scrolled by a focus is the sideways-shifted header this app already shipped once.
 */
export const revealInScroller = (
  element: Element,
  overflowY: (node: Element) => string = node => getComputedStyle(node).overflowY,
): void => {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = overflowY(node);
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const field = element.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    // Down far enough to show the field's bottom, but never so far that its top (its label's line) leaves.
    if (field.bottom > box.bottom)
      node.scrollTop += Math.min(field.bottom - box.bottom + REVEAL_MARGIN_PX, field.top - box.top - REVEAL_MARGIN_PX);
    else if (field.top < box.top) node.scrollTop -= box.top - field.top + REVEAL_MARGIN_PX;
  }
};

/**
 * Installs the browser producer. The explicit port makes the geometry policy
 * testable without replacing global browser APIs, while production uses the
 * browser environment below.
 */
export const installAppViewport = (env: AppViewportEnvironment): (() => void) => {
  let frame: number | null = null;
  let keyboardWasOpen = false;
  const baselines = new Map<number, number>();

  const apply = () => {
    frame = null;
    const visual = env.visualViewport?.read();
    const height = Math.round(visual?.height ?? env.innerHeight());
    const offsetTop = Math.max(0, Math.round(visual?.offsetTop ?? 0));
    const hidden = Math.max(0, Math.round(env.innerHeight() - height - offsetTop));
    const width = env.innerWidth();
    const typing = isTextEntry(env.document.activeElement);

    // A baseline is learned only while a text field is not focused; a keyboard
    // frame must never become the reference used to detect that same keyboard.
    if (!typing) baselines.set(width, Math.max(baselines.get(width) ?? 0, height));
    if (baselines.size > 6) baselines.delete(baselines.keys().next().value as number);
    const baseline = baselines.get(width) ?? 0;
    const phoneLike = env.coarsePointer() || width < DRAWER_MAX;
    const keyboardOpen = phoneLike && (hidden > KEYBOARD_MIN_PX || (typing && height < baseline - KEYBOARD_MIN_PX));

    // The visible box sizes the shell ONLY while a keyboard pans it. At rest the stylesheet's `100dvh` is the
    // screen, and a number read here could only be worse: a stale frame after the keyboard closed, a pinch
    // zoom's slice, or iOS 26 standalone's short first viewport (styles/index.css, "AN INSTALLED iOS 26 APP").
    if (keyboardOpen) {
      env.root.style.setProperty('--app-h', `${height}px`);
      env.root.style.setProperty('--app-top', `${offsetTop}px`);
    } else {
      env.root.style.removeProperty('--app-h');
      env.root.style.removeProperty('--app-top');
    }
    env.root.style.setProperty('--kb-h', `${hidden}px`);
    if (keyboardOpen) env.root.setAttribute(KEYBOARD_ATTRIBUTE, 'open');
    else env.root.removeAttribute(KEYBOARD_ATTRIBUTE);
    // The keyboard just came up over a focused field. The shell is now the short visible box, but the field
    // stayed where it was, under the keyboard or the chrome that rode up with it. Bring it back into its
    // own scroller; a field already in view does not move.
    if (keyboardOpen && !keyboardWasOpen && typing) env.reveal(env.document.activeElement as Element);
    keyboardWasOpen = keyboardOpen;

    const scroll = env.scroll();
    if (scroll.x !== 0 || scroll.y !== 0) env.scrollTo(0, 0);
  };
  const schedule = () => {
    if (frame !== null) return;
    frame = env.requestFrame(apply);
  };

  apply();
  env.visualViewport?.addEventListener('resize', schedule);
  env.visualViewport?.addEventListener('scroll', schedule);
  env.addWindowListener('resize', schedule);
  env.addWindowListener('orientationchange', schedule);
  env.document.addEventListener('visibilitychange', schedule);

  return () => {
    if (frame !== null) env.cancelFrame(frame);
    env.visualViewport?.removeEventListener('resize', schedule);
    env.visualViewport?.removeEventListener('scroll', schedule);
    env.removeWindowListener('resize', schedule);
    env.removeWindowListener('orientationchange', schedule);
    env.document.removeEventListener('visibilitychange', schedule);
  };
};

const browserViewportEnvironment = (): AppViewportEnvironment | null => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const viewport = window.visualViewport;
  return {
    root: document.documentElement,
    document,
    innerWidth: () => window.innerWidth,
    innerHeight: () => window.innerHeight,
    scroll: () => ({ x: window.scrollX, y: window.scrollY }),
    scrollTo: (x, y) => window.scrollTo(x, y),
    visualViewport: viewport
      ? {
          read: () => ({ height: viewport.height, offsetTop: viewport.offsetTop }),
          addEventListener: (type, listener) => viewport.addEventListener(type, listener),
          removeEventListener: (type, listener) => viewport.removeEventListener(type, listener),
        }
      : null,
    coarsePointer: () => window.matchMedia?.('(pointer: coarse)').matches ?? false,
    requestFrame: callback => window.requestAnimationFrame(callback),
    cancelFrame: id => window.cancelAnimationFrame(id),
    addWindowListener: (type, listener) => window.addEventListener(type, listener),
    removeWindowListener: (type, listener) => window.removeEventListener(type, listener),
    reveal: element => revealInScroller(element),
  };
};

/** Mount once beside the fixed shell. Without a visualViewport it safely falls back to innerHeight. */
export const useAppViewport = (): void => {
  useEffect(() => {
    const env = browserViewportEnvironment();
    return env ? installAppViewport(env) : undefined;
  }, []);
};
