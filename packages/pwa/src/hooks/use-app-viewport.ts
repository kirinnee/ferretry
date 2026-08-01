/**
 * Keep the fixed application shell aligned with the visual viewport.
 *
 * iOS can pan a `100dvh` fixed shell above its software keyboard without
 * resizing it.  The stylesheet already consumes these properties, so this
 * module is the sole producer of `--app-h`, `--app-top`, `--kb-h`, and the
 * `data-keyboard` state observed by `useKeyboardOpen`.
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
}

const isTextEntry = (element: Element | null): boolean => {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable || element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  return !['button', 'checkbox', 'radio', 'range', 'submit'].includes((element as HTMLInputElement).type);
};

/**
 * Installs the browser producer. The explicit port makes the geometry policy
 * testable without replacing global browser APIs, while production uses the
 * browser environment below.
 */
export const installAppViewport = (env: AppViewportEnvironment): (() => void) => {
  let frame: number | null = null;
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

    env.root.style.setProperty('--app-h', `${height}px`);
    env.root.style.setProperty('--app-top', `${offsetTop}px`);
    env.root.style.setProperty('--kb-h', `${hidden}px`);
    if (keyboardOpen) env.root.setAttribute(KEYBOARD_ATTRIBUTE, 'open');
    else env.root.removeAttribute(KEYBOARD_ATTRIBUTE);

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
  };
};

/** Mount once beside the fixed shell. Without a visualViewport it safely falls back to innerHeight. */
export const useAppViewport = (): void => {
  useEffect(() => {
    const env = browserViewportEnvironment();
    return env ? installAppViewport(env) : undefined;
  }, []);
};
