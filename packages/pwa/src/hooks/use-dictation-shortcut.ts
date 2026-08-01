/**
 * Browser wiring for the pure shortcut policy in `dictation-shortcut.ts`.
 *
 * One instance is mounted beside each retained composer; only the textarea in
 * the visible (not aria-hidden) pane is eligible, so a two-pane LRU cannot
 * start two microphones from one physical key press.
 *
 * The event target is a parameter rather than a reached-for `window`, which is
 * what lets the eligibility rules — the part that actually goes wrong — be
 * tested against a plain object instead of a global.
 */

import { useEffect, useRef } from 'react';
import {
  type DictationShortcutAction,
  type DictationShortcutBinding,
  DictationShortcutGesture,
  dictationShortcutCaptureActive,
  matchesDictationShortcut,
  sameDictationShortcutTrigger,
} from '../features/settings/dictation-shortcut.ts';
import type { DictationPhase } from '../lib/stt/utterance.ts';

export interface ShortcutDictationHandle {
  readonly phase: DictationPhase;
  start(): void;
  stop(): void;
}

/** The narrow slice of `window`/`document` this hook listens to. */
export interface ShortcutEventTarget {
  addEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
}

export interface ShortcutHost {
  readonly keys: ShortcutEventTarget;
  readonly visibility: ShortcutEventTarget;
  /** `'hidden'` means the tab went away and any capture must be released. */
  visibilityState(): string;
  /** Monotonic-ish clock for the hold/latch decision. */
  now(): number;
}

export interface DictationShortcutOptions {
  readonly binding: DictationShortcutBinding;
  readonly handle: ShortcutDictationHandle;
  readonly composerRef: { current: HTMLElement | null };
  readonly host: ShortcutHost | null;
  readonly disabled?: boolean;
}

interface ClosestLike {
  readonly isConnected?: boolean;
  closest?(selector: string): unknown;
}

/** Retained chat panes are marked aria-hidden and invisible by the shell. */
export const isActiveShortcutComposer = (element: ClosestLike | null): boolean => {
  if (element === null || element.isConnected === false) return false;
  if (typeof element.closest !== 'function') return true;
  return element.closest('[aria-hidden="true"], [inert]') === null;
};

/**
 * Do not let a chord configured for dictation steal a Settings or palette key
 * capture, or another text field. The active composer itself is allowed.
 */
export const shortcutTargetAllowed = (target: unknown, composer: HTMLElement | null): boolean => {
  if (target === null || typeof target !== 'object') return true;
  if (target === composer) return true;
  const element = target as ClosestLike & { tagName?: string; isContentEditable?: boolean };
  if (typeof element.closest === 'function') {
    if (element.closest('[role="dialog"], [aria-modal="true"], [data-settings-scroller]') !== null) return false;
    if (element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null) return false;
  }
  const tag = element.tagName?.toLocaleLowerCase();
  return tag !== 'input' && tag !== 'textarea' && tag !== 'select' && element.isContentEditable !== true;
};

/** Which phases mean a microphone is open, as far as the gesture is concerned. */
export const isRecordingPhase = (phase: DictationPhase): boolean => phase === 'requesting' || phase === 'recording';

const runAction = (action: DictationShortcutAction, handle: ShortcutDictationHandle): void => {
  if (action === 'start') handle.start();
  else if (action === 'stop') handle.stop();
};

export function useDictationShortcut({ binding, handle, composerRef, host, disabled }: DictationShortcutOptions): void {
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const gestureRef = useRef<DictationShortcutGesture | null>(null);
  gestureRef.current ??= new DictationShortcutGesture();
  const gesture = gestureRef.current;

  // A stop from the visible panel (or completion, or an error) must not leave
  // the shortcut thinking its earlier tap is still latched.
  useEffect(() => {
    if (handle.phase === 'idle' || handle.phase === 'transcribing' || handle.phase === 'error') gesture.reset();
  }, [handle.phase, gesture]);

  useEffect(() => {
    if (disabled === true || host === null) return;

    const eligible = (target: EventTarget | null): boolean => {
      const composer = composerRef.current;
      return isActiveShortcutComposer(composer) && shortcutTargetAllowed(target, composer);
    };

    const prevent = (event: KeyboardEvent): void => {
      // In particular, stop bare Alt from opening a browser menu after the page
      // has positively matched and claimed it.
      event.preventDefault();
      event.stopPropagation();
    };

    const onKeyDown = (event: Event): void => {
      const key = event as KeyboardEvent;
      if (dictationShortcutCaptureActive() || key.isComposing || key.keyCode === 229) return;
      if (!eligible(key.target) || !matchesDictationShortcut(binding, key)) return;
      prevent(key);
      if (key.repeat) return;
      const current = handleRef.current;
      runAction(gesture.keyDown(host.now(), isRecordingPhase(current.phase)), current);
    };

    const onKeyUp = (event: Event): void => {
      const key = event as KeyboardEvent;
      if (dictationShortcutCaptureActive() || !eligible(key.target)) return;
      // Modifier flags can already be false on their own keyup, so the matching
      // keydown owns the gesture and keyup needs only the same physical trigger.
      if (!sameDictationShortcutTrigger(binding, key)) return;
      prevent(key);
      const current = handleRef.current;
      runAction(gesture.keyUp(host.now()), current);
    };

    const release = (): void => runAction(gesture.blur(), handleRef.current);

    const onVisibility = (): void => {
      if (host.visibilityState() === 'hidden') release();
    };

    // Capture before composer, autocomplete and panel handlers. A matched
    // shortcut is an app command; an unmatched key continues untouched.
    host.keys.addEventListener('keydown', onKeyDown, true);
    host.keys.addEventListener('keyup', onKeyUp, true);
    host.keys.addEventListener('blur', release);
    host.visibility.addEventListener('visibilitychange', onVisibility);
    return () => {
      host.keys.removeEventListener('keydown', onKeyDown, true);
      host.keys.removeEventListener('keyup', onKeyUp, true);
      host.keys.removeEventListener('blur', release);
      host.visibility.removeEventListener('visibilitychange', onVisibility);
      release();
    };
  }, [binding, composerRef, disabled, gesture, host]);
}

/** The real browser host. Built by the composition root, never reached for here. */
export const browserShortcutHost = (window: Window & typeof globalThis, document: Document): ShortcutHost => ({
  keys: window as unknown as ShortcutEventTarget,
  visibility: document as unknown as ShortcutEventTarget,
  visibilityState: () => document.visibilityState,
  now: () => window.performance.now(),
});
