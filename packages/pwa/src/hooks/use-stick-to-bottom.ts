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
import { type ChatScroll, type ChatScrollSlot, restorableTop } from '../lib/scroll-memory.ts';
import {
  followPinBlocked,
  gapFromBottom,
  jumpPillShown,
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
  /**
   * Where this view's reading position is kept (`lib/scroll-memory.ts`). Read once, when the view
   * opens: a reader who left it scrolled up comes back to that spot, detached, with "jump to latest"
   * on offer; one who left it at the latest lands there as before. Written as the reader moves. A
   * deliberate return (`resetKey` changing after the open, e.g. a send) still lands at the latest.
   */
  readonly memory?: ChatScrollSlot;
}

/** How long a saved position waits for the content to grow tall enough before settling for the nearest. */
export const READING_RESTORE_PATIENCE_MS = 4_000;
/** How long the reader's position settles before it is written: a fling is one write, not hundreds. */
export const READING_WRITE_SETTLE_MS = 150;

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
  /**
   * Should "jump to latest" show: detached AND far enough from the bottom (with hysteresis, so drift near the
   * tail never toggles it). A host renders the pill from this and keeps its box the same either way.
   */
  readonly jumpShown: boolean;
  readonly onScroll: () => void;
  readonly jumpToLatest: () => void;
  /** Move the viewport for a reason of the host's own (a prepend), recorded so it is never read as the reader. */
  readonly scrollTo: (top: number) => void;
}

/** Is a pin unsafe right now: a pointer held on the viewport, or a selection held inside it? */
const pinBlockedNow = (element: HTMLElement, pointerHeld: boolean): boolean =>
  followPinBlocked(pointerHeld, globalThis.window?.getSelection() ?? null, node => element.contains(node));

export function useStickToBottom({ resetKey, contentKeys, onFollow, memory }: StickToBottomOptions): StickToBottom {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /**
   * The saved reading position, read ONCE at the first render and kept only when it was not at the
   * latest — so the very first layout pass already knows not to pin over it.
   */
  const opening = useRef<ChatScroll | null | undefined>(undefined);
  if (opening.current === undefined) {
    const saved = memory?.read() ?? null;
    opening.current = saved !== null && !saved.atLatest ? saved : null;
  }
  /** The reset key the view opened under: only that open restores; every later key is a return. */
  const openKey = useRef(resetKey);
  const following = useRef(opening.current === null);
  const [detached, setDetached] = useState(opening.current !== null);
  const [jumpShown, setJumpShown] = useState(opening.current !== null);
  const jumpShownNow = useRef(jumpShown);
  jumpShownNow.current = jumpShown;
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
  const memoryRef = useRef(memory);
  memoryRef.current = memory;
  /** A saved reading position still waiting for content tall enough to hold it. */
  const pendingRestore = useRef<number | null>(opening.current?.top ?? null);
  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Writes where the reader is, once the movement settles. */
  const record = useCallback((element: HTMLElement) => {
    if (memoryRef.current === undefined) return;
    if (writeTimer.current !== null) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      writeTimer.current = null;
      memoryRef.current?.write({ top: element.scrollTop, atLatest: following.current });
    }, READING_WRITE_SETTLE_MS);
  }, []);

  const remember = useCallback((element: HTMLElement) => {
    lastScrollTop.current = element.scrollTop;
    prevScrollHeight.current = element.scrollHeight;
    prevClientHeight.current = element.clientHeight;
  }, []);

  /** Re-decides the pill from where the reader is; a state write only when the answer changes. */
  const showJump = useCallback((detachedNow: boolean, distance: number) => {
    const next = jumpPillShown(jumpShownNow.current, detachedNow, distance);
    if (next !== jumpShownNow.current) setJumpShown(next);
  }, []);

  const pin = useCallback(() => {
    const element = viewportRef.current;
    if (element === null || pinBlockedNow(element, pointerHeld.current)) return;
    element.scrollTop = element.scrollHeight;
    remember(element);
  }, [remember]);

  const follow = useCallback(() => {
    following.current = true;
    pendingRestore.current = null;
    setDetached(false);
    showJump(false, 0);
    onFollowRef.current?.();
    pin();
    const element = viewportRef.current;
    if (element !== null) record(element);
  }, [pin, record, showJump]);

  /**
   * Puts a saved reading position back once the content can hold it. `final` takes the nearest offset
   * instead: the content has had its chance to arrive.
   */
  const restore = useCallback(
    (final: boolean): void => {
      const element = viewportRef.current;
      const saved = pendingRestore.current;
      if (element === null || saved === null) return;
      const target = restorableTop(saved, element, final);
      if (target === undefined) return;
      pendingRestore.current = null;
      element.scrollTop = target;
      remember(element);
      gap.current = gapFromBottom(element);
    },
    [remember],
  );

  // ---- OPEN / RETURN: land at the latest and follow ------------------------------------------------
  // Now, then next frame, which covers layout that settles within the same tick; slower layout is the
  // resize observer's job. A stale intent stamp must not survive into the new view's first frames, or
  // its settling layout could be read as the reader scrolling.
  //
  // THE OPEN MAY RESTORE INSTEAD. The reset the view opened under puts back the position read at the
  // first render (now if the content is there, else as it arrives, else the
  // nearest offset after a patient wait) and the view opens detached. Every later reset is a return.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the deliberate trigger
  useEffect(() => {
    intentAt.current = Number.NEGATIVE_INFINITY;
    const saved = resetKey === openKey.current ? opening.current : null;
    if (saved !== null && saved !== undefined) {
      following.current = false;
      setDetached(true);
      setJumpShown(true);
      pendingRestore.current = saved.top;
      restore(false);
      const deadline = setTimeout(() => restore(true), READING_RESTORE_PATIENCE_MS);
      return () => clearTimeout(deadline);
    }
    follow();
    const frame = globalThis.requestAnimationFrame?.(pin);
    return () => {
      if (frame !== undefined) globalThis.cancelAnimationFrame(frame);
    };
  }, [resetKey, follow, pin, restore]);

  // ---- FOLLOWING: re-pin in the same commit that added content --------------------------------------
  // A restore still waiting for content tries again in the same commit, before paint.
  useLayoutEffect(() => {
    if (following.current) pin();
    else restore(false);
  }, [pin, restore, ...contentKeys]);

  // ---- THE LAST POSITION IS WRITTEN ON THE WAY OUT --------------------------------------------------
  useEffect(
    () => () => {
      if (writeTimer.current === null) return;
      clearTimeout(writeTimer.current);
      writeTimer.current = null;
      // The scroller has already left the document here, so its last OBSERVED offset is what is written.
      memoryRef.current?.write({ top: lastScrollTop.current, atLatest: following.current });
    },
    [],
  );

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
      else {
        restore(false);
        gap.current = gapFromBottom(element);
        showJump(true, gap.current);
      }
      prevScrollHeight.current = element.scrollHeight;
      prevClientHeight.current = element.clientHeight;
    });
    observer.observe(element);
    if (contentRef.current !== null) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [pin, restore, showJump]);

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
    showJump(!following.current, gap.current);
    record(element);
  }, [follow, record, remember, showJump]);

  const scrollTo = useCallback((top: number): void => {
    const element = viewportRef.current;
    if (element === null) return;
    element.scrollTop = top;
    lastScrollTop.current = element.scrollTop;
  }, []);

  return { viewportRef, contentRef, following, gap, detached, jumpShown, onScroll, jumpToLatest: follow, scrollTo };
}
