/**
 * The platform's full-screen facility, behind a port.
 *
 * `requestFullscreen` is a browser global with prefixed spellings, a permission model and
 * one device (iPhone Safari) that has no such thing for an ordinary element. Everything
 * that decides what a surface does about it lives in `useFullscreen`; this module is the
 * only place that touches `document` and `Element`, so that decision can be tested with a
 * fake and the real wiring stays a thin, unsurprising adapter.
 *
 * Keyboard Lock is asked for alongside it. Without the lock the browser swallows a plain
 * Escape to leave full screen, which is exactly the key a shell (vim, readline) and a
 * remote page need to receive; with it, Escape reaches the surface and Shift+Escape (see
 * `keyboard-capture.ts`) is the way out, the same chord the overlay uses.
 */

export interface FullscreenPort {
  /** Whether this element can be made the document's full-screen element here. */
  canRequest(element: HTMLElement): boolean;
  request(element: HTMLElement): Promise<void>;
  exit(): Promise<void>;
  /** The element that is full screen right now, if any. */
  current(): Element | null;
  /** Calls back whenever the document enters or leaves full screen; returns the way to stop. */
  subscribe(listener: () => void): () => void;
}

interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface PrefixedDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}

interface LockableKeyboard {
  lock?(keyCodes?: string[]): Promise<void>;
  unlock?(): void;
}

const keyboard = (): LockableKeyboard | undefined => (navigator as { keyboard?: LockableKeyboard }).keyboard;

const lockEscape = (): void => {
  try {
    void keyboard()
      ?.lock?.(['Escape'])
      .catch(() => undefined);
  } catch {
    // Keyboard Lock is an enhancement; a browser that refuses it still has the Shift+Escape chord.
  }
};

export const browserFullscreenPort: FullscreenPort = {
  canRequest: element =>
    typeof element.requestFullscreen === 'function' ||
    typeof (element as PrefixedElement).webkitRequestFullscreen === 'function',
  request: async element => {
    const prefixed = element as PrefixedElement;
    if (typeof element.requestFullscreen === 'function') await element.requestFullscreen({ navigationUI: 'hide' });
    else await prefixed.webkitRequestFullscreen?.();
    lockEscape();
  },
  exit: async () => {
    const doc = document as PrefixedDocument;
    keyboard()?.unlock?.();
    if (typeof doc.exitFullscreen === 'function') await doc.exitFullscreen();
    else await doc.webkitExitFullscreen?.();
  },
  current: () => document.fullscreenElement ?? (document as PrefixedDocument).webkitFullscreenElement ?? null,
  subscribe: listener => {
    document.addEventListener('fullscreenchange', listener);
    document.addEventListener('webkitfullscreenchange', listener);
    return () => {
      document.removeEventListener('fullscreenchange', listener);
      document.removeEventListener('webkitfullscreenchange', listener);
    };
  },
};
