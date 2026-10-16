/**
 * STICK TO THE BOTTOM UNLESS THE READER SCROLLED UP — kteam's follow model, for any scroller whose
 * new content arrives at the end: the Chat transcript and the Console pane.
 *
 * Ported from kteam's `components/Transcript.tsx`; each decision is a pure function in
 * `lib/transcript-follow.ts` with the measurement behind it. The shape:
 *
 *   FOLLOWING — the reader is at the bottom. Anything that grows the content (a new row, a message
 *     growing in place, a block laying out late, a fresh pane capture) pins to the tail before paint,
 *     by plain assignment: a smooth animation restarted on every delta IS the bounce.
 *   DETACHED — the reader scrolled up, with an input event to prove it was them. Nothing here writes
 *     `scrollTop` again until they come back within reach of the bottom or press "jump to latest".
 *   OPENED — a new `resetKey` (another session, or a deliberate return such as a send) lands at the
 *     tail and follows, now and again next frame.
 *
 * Follow never pins while a pointer is held on the scroller or a text selection is held inside it: a
 * `scrollTop` write collapses a selection, and mid long-press it moves the text out from under the
 * finger.
 */

import { type MutableRefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  followPinBlocked,
  gapFromBottom,
  scrollIsByReader,
  scrollVerdict,
  TRANSCRIPT_SCROLL_KEYS,
} from '../lib/transcript-follow.ts';
import { TOUCH_SELECTION_RELEASE_SETTLE_MS } from './use-live-clock.ts';

export interface StickToBottomOptions {
  /** A change is a newly opened view, or a deliberate return to the tail: land at the latest and follow. */
  readonly resetKey: string | number;
  /** A change is new content: a following reader is re-pinned in the same commit, before paint. */
  readonly contentKeys: readonly unknown[];
  /** Called whenever follow (re-)engages, so a host can clear its "N new" count. */
  readonly onFollow?: () => void;
}

export interface StickToBottom {
  readonly viewportRef: MutableRefObject<HTMLDivElement | null>;
  /** The element whose size is the content's. Optional: without it only the viewport is observed. */
  readonly contentRef: MutableRefObject<HTMLDivElement | null>;
  /** Sticky: is the reader pinned to the bottom? Read it; only this hook writes it. */
  readonly following: MutableRefObject<boolean>;
  /** Distance from the bottom at the last settled observation — what a prepend restores. */
  readonly gap: MutableRefObject<number>;
  /** True once the reader has scrolled away — the cue to show "jump to latest". */
  readonly detached: boolean;
  readonly onScroll: () => void;
  readonly jumpToLatest: () => void;
  /** Move the viewport for a reason of the host's own (a prepend), recorded so it is never read as the reader. */
  readonly scrollTo: (top: number) => void;
}

/** Is a pin unsafe right now: a pointer held on the viewport, or a selection held inside it? */
const pinBlockedNow = (element: HTMLElement, pointerHeld: boolean): boolean =>
  followPinBlocked(pointerHeld, globalThis.window?.getSelection() ?? null, node => element.contains(node));

export function useStickToBottom({ resetKey, contentKeys, onFollow }: StickToBottomOptions): StickToBottom {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const [detached, setDetached] = useState(false);
  /** scrollTop last OBSERVED or SET, so this end's own pins are never read as the reader moving. */
  const lastScrollTop = useRef(0);
  const prevScrollHeight = useRef(0);
  const prevClientHeight = useRef(0);
  const gap = useRef(0);
  /** performance.now() of the last discrete input on the viewport. */
  const intentAt = useRef(Number.NEGATIVE_INFINITY);
  /** A pointer held on the viewport, latched for the whole gesture (a scrollbar drag, a finger). */
  const pointerHeld = useRef(false);
  const repinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFollowRef = useRef(onFollow);
  onFollowRef.current = onFollow;

  const remember = useCallback((element: HTMLElement) => {
    lastScrollTop.current = element.scrollTop;
    prevScrollHeight.current = element.scrollHeight;
    prevClientHeight.current = element.clientHeight;
  }, []);

  const pin = useCallback(() => {
    const element = viewportRef.current;
    if (element === null || pinBlockedNow(element, pointerHeld.current)) return;
    element.scrollTop = element.scrollHeight;
    remember(element);
  }, [remember]);

  const follow = useCallback(() => {
    following.current = true;
    setDetached(false);
    onFollowRef.current?.();
    pin();
  }, [pin]);

  // ---- OPEN / RETURN: land at the latest and follow ------------------------------------------------
  // Now, then next frame, which covers layout that settles within the same tick; slower layout is the
  // resize observer's job. A stale intent stamp must not survive into the new view's first frames, or
  // its settling layout could be read as the reader scrolling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the deliberate trigger
  useEffect(() => {
    intentAt.current = Number.NEGATIVE_INFINITY;
    follow();
    const frame = globalThis.requestAnimationFrame?.(pin);
    return () => {
      if (frame !== undefined) globalThis.cancelAnimationFrame(frame);
    };
  }, [resetKey, follow, pin]);

  // ---- FOLLOWING: re-pin in the same commit that added content --------------------------------------
  useLayoutEffect(() => {
    if (following.current) pin();
  }, [pin, ...contentKeys]);

  // ---- INTENT: the only thing allowed to break follow -----------------------------------------------
  // Every device that scrolls a region announces itself before its scroll lands, and nothing layout
  // does can forge one. Discrete inputs stamp `intentAt`; a pressed pointer is latched until released
  // anywhere in the window (a drag often ends outside the scroller, and a tab switch mid-drag sends no
  // pointerup at all, hence `blur`).
  useEffect(() => {
    const element = viewportRef.current;
    const view = globalThis.window;
    if (element === null || view === undefined) return;
    const mark = (): void => {
      intentAt.current = performance.now();
    };
    const down = (): void => {
      pointerHeld.current = true;
      mark();
    };
    // The re-pin after a gesture waits a beat and re-checks the guard: on a touch long-press the
    // selection may only materialise just after the finger lifts, and a pin then would land in the
    // very gesture that was about to produce a highlight.
    const up = (): void => {
      pointerHeld.current = false;
      mark();
      if (repinTimer.current !== null) clearTimeout(repinTimer.current);
      repinTimer.current = setTimeout(() => {
        repinTimer.current = null;
        if (following.current) pin();
      }, TOUCH_SELECTION_RELEASE_SETTLE_MS);
    };
    const key = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // Typing in a field moves a caret, not the scroller.
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true) return;
      if (TRANSCRIPT_SCROLL_KEYS.has(event.key)) mark();
    };
    const passive = { passive: true } as const;
    const presses = ['touchstart', 'pointerdown'] as const;
    const moves = ['wheel', 'touchmove'] as const;
    const releases = ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur'] as const;
    for (const type of presses) element.addEventListener(type, down, passive);
    for (const type of moves) element.addEventListener(type, mark, passive);
    for (const type of releases) view.addEventListener(type, up, passive);
    view.addEventListener('keydown', key, passive);
    return () => {
      for (const type of presses) element.removeEventListener(type, down);
      for (const type of moves) element.removeEventListener(type, mark);
      for (const type of releases) view.removeEventListener(type, up);
      view.removeEventListener('keydown', key);
      if (repinTimer.current !== null) clearTimeout(repinTimer.current);
      repinTimer.current = null;
    };
  }, [pin]);

  // ---- A CLEARED SELECTION RELEASES FOLLOW'S HOLD ---------------------------------------------------
  // While a selection is held nothing pins, so content that stopped arriving meanwhile would strand a
  // following reader just short of the bottom. pin() is a no-op while the selection still stands.
  useEffect(() => {
    const doc = globalThis.document;
    if (doc === undefined) return;
    const changed = (): void => {
      if (following.current) pin();
    };
    doc.addEventListener('selectionchange', changed, { passive: true });
    return () => doc.removeEventListener('selectionchange', changed);
  }, [pin]);

  // ---- RESIZE: content growing in place, or the viewport itself changing ----------------------------
  // One observer covers a new row, a message gaining tokens and a block laying out late (content), and
  // the keyboard, a growing composer and a window resize (viewport). A detached reader is never moved;
  // only the prepend baseline is refreshed.
  useEffect(() => {
    const element = viewportRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current) pin();
      else gap.current = gapFromBottom(element);
      prevScrollHeight.current = element.scrollHeight;
      prevClientHeight.current = element.clientHeight;
    });
    observer.observe(element);
    if (contentRef.current !== null) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [pin]);

  const onScroll = useCallback((): void => {
    const element = viewportRef.current;
    if (element === null) return;
    const verdict = scrollVerdict(
      element,
      {
        lastScrollTop: lastScrollTop.current,
        scrollHeight: prevScrollHeight.current,
        clientHeight: prevClientHeight.current,
      },
      {
        following: following.current,
        byReader: scrollIsByReader(pointerHeld.current, intentAt.current, performance.now()),
      },
    );
    if (verdict === 'detach') {
      following.current = false;
      setDetached(true);
    } else if (verdict === 'reengage') {
      // Back at the bottom under their own steam: resume, and land exactly on the tail.
      follow();
    }
    remember(element);
    gap.current = gapFromBottom(element);
  }, [follow, remember]);

  const scrollTo = useCallback((top: number): void => {
    const element = viewportRef.current;
    if (element === null) return;
    element.scrollTop = top;
    lastScrollTop.current = element.scrollTop;
  }, []);

  return { viewportRef, contentRef, following, gap, detached, onScroll, jumpToLatest: follow, scrollTo };
}
