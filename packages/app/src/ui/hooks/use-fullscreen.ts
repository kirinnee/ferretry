/**
 * Full screen for one surface (a shell, a browser page).
 *
 * Two ways to be full screen, one answer to the reader. Where the platform will make the
 * surface's element the document's full-screen element it does, which also hides the
 * browser's own chrome. Where it will not (iPhone Safari, a refused request) the surface
 * becomes a fixed overlay over the viewport instead — `mode` says which, and the host's
 * CSS turns `active` into the overlay either way, so the two never look different.
 *
 * LEAVING is always possible: the toggle, the platform's own gesture (mirrored back by
 * `fullscreenchange`), and Escape — except that Escape inside a keyboard-owning surface is
 * the surface's own, so there Shift+Escape leaves, as everywhere else in the app.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserFullscreenPort, type FullscreenPort } from '../lib/fullscreen.ts';
import { isCaptureEscapeChord, isKeyboardCaptured } from '../lib/keyboard-capture.ts';

type FullscreenMode = 'off' | 'native' | 'overlay';

export interface SurfaceFullscreen<T extends HTMLElement> {
  /** Goes on the element that should fill the screen. */
  readonly ref: React.RefObject<T | null>;
  readonly mode: FullscreenMode;
  readonly active: boolean;
  readonly toggle: () => void;
  readonly exit: () => void;
}

export function useFullscreen<T extends HTMLElement>(
  port: FullscreenPort = browserFullscreenPort,
): SurfaceFullscreen<T> {
  const ref = useRef<T>(null);
  const [mode, setMode] = useState<FullscreenMode>('off');
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const exit = useCallback((): void => {
    if (modeRef.current === 'native') void port.exit().catch(() => undefined);
    setMode('off');
  }, [port]);

  const toggle = useCallback((): void => {
    if (modeRef.current !== 'off') {
      exit();
      return;
    }
    const element = ref.current;
    if (element === null || !port.canRequest(element)) {
      setMode('overlay');
      return;
    }
    port.request(element).then(
      () => setMode('native'),
      () => setMode('overlay'),
    );
  }, [exit, port]);

  // The platform's own way out (its Escape, a swipe) must be mirrored, or the surface would stay dressed as full screen.
  useEffect(
    () =>
      port.subscribe(() => {
        if (modeRef.current === 'native' && port.current() !== ref.current) setMode('off');
      }),
    [port],
  );

  useEffect(() => {
    if (mode === 'off') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (isKeyboardCaptured(event.target) && !isCaptureEscapeChord(event)) return;
      exit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, exit]);

  // A surface that unmounts while full screen must not leave the whole document full screen with nothing in it.
  useEffect(
    () => () => {
      if (modeRef.current === 'native') void port.exit().catch(() => undefined);
    },
    [port],
  );

  return { ref, mode, active: mode !== 'off', toggle, exit };
}
