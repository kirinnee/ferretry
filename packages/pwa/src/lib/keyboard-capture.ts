/**
 * A surface that owns the keyboard (the remote browser view, a terminal).
 *
 * While focus is inside one, every key is the surface's: app shortcuts such as
 * `/` search, Cmd/Ctrl+K, dictation and Escape-to-close must not see it. The one
 * way out is an explicit chord, so a reader is never trapped.
 */

/** Marker attribute a keyboard-owning surface carries on (or above) its focusable element. */
export const KEYBOARD_CAPTURE_ATTRIBUTE = 'data-keyboard-capture';

const KEYBOARD_CAPTURE_SELECTOR = `[${KEYBOARD_CAPTURE_ATTRIBUTE}]`;

interface CaptureTargetLike {
  closest?(selector: string): unknown;
}

/** Structural, not `instanceof`: the event may come from another realm. */
export const isKeyboardCaptured = (target: EventTarget | null | undefined): boolean => {
  if (target === null || target === undefined || typeof target !== 'object') return false;
  const closest = (target as CaptureTargetLike).closest;
  return typeof closest === 'function' && closest.call(target, KEYBOARD_CAPTURE_SELECTOR) !== null;
};

interface ChordEventLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** Shift+Escape: the explicit way out of a keyboard-owning surface. Plain Escape belongs to the page. */
export const isCaptureEscapeChord = (event: ChordEventLike): boolean =>
  event.key === 'Escape' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
