import { useEffect, useState, useSyncExternalStore } from 'react';

/** The small portion of Selection needed by the transcript safety gate. */
export interface TickSelectionLike {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
}

/** A caret is not a held text selection. */
export const selectionHeld = (selection: TickSelectionLike | null): boolean =>
  selection !== null && !selection.isCollapsed && selection.rangeCount > 0;

/**
 * A completed selection is not sufficient on touch: WebKit may not materialise
 * its range until after a long-press gesture. Holding while a pointer is down
 * protects that blind window too.
 */
export const transcriptHeldStill = (pointerHeld: boolean, selection: TickSelectionLike | null): boolean =>
  pointerHeld || selectionHeld(selection);

export const MAX_TRANSCRIPT_HOLD_MS = 20_000;
export const TOUCH_SELECTION_RELEASE_SETTLE_MS = 220;

type HoldListener = () => void;
const holdListeners = new Set<HoldListener>();
let holdAttached = false;
let pointerHeld = false;
let holding = false;
let capTimer: ReturnType<typeof setTimeout> | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

const readSelection = (): TickSelectionLike | null => {
  if (typeof document === 'undefined') return null;
  return document.getSelection();
};

const publishHold = (): void => {
  const next = transcriptHeldStill(pointerHeld, readSelection());
  if (next === holding) return;
  holding = next;
  for (const listener of holdListeners) listener();
};

const clearHoldTimers = (): void => {
  if (capTimer !== undefined) clearTimeout(capTimer);
  if (releaseTimer !== undefined) clearTimeout(releaseTimer);
  capTimer = undefined;
  releaseTimer = undefined;
};

const attachTranscriptHold = (): void => {
  if (holdAttached || typeof document === 'undefined') return;
  holdAttached = true;
  const hold = (): void => {
    pointerHeld = true;
    clearHoldTimers();
    capTimer = setTimeout(() => {
      pointerHeld = false;
      publishHold();
    }, MAX_TRANSCRIPT_HOLD_MS);
    publishHold();
  };
  const release = (event: PointerEvent): void => {
    pointerHeld = false;
    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
      if (releaseTimer !== undefined) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        releaseTimer = undefined;
        publishHold();
      }, TOUCH_SELECTION_RELEASE_SETTLE_MS);
      return;
    }
    publishHold();
  };
  // The handlers are deliberately installed once for the document: all
  // transcript rows must agree on the same frozen timestamp.
  document.addEventListener('selectionchange', publishHold);
  document.addEventListener('pointerdown', hold);
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  window.addEventListener('blur', () => {
    pointerHeld = false;
    clearHoldTimers();
    publishHold();
  });
};

/** Subscribe without React; kept public for DOM-free controller tests. */
export const subscribeTranscriptHold = (listener: HoldListener): (() => void) => {
  holdListeners.add(listener);
  attachTranscriptHold();
  return () => holdListeners.delete(listener);
};

const transcriptHoldSnapshot = (): boolean => holding;

/**
 * One document-level selection gate. The external store avoids each timer
 * attaching a competing event handler, and makes all timestamp consumers
 * freeze together during a selection gesture.
 */
export const useTranscriptHold = (): boolean =>
  useSyncExternalStore(subscribeTranscriptHold, transcriptHoldSnapshot, () => false);

/**
 * A wall-clock timestamp that advances about once a second, for the transcript's
 * live labels (a running tool's elapsed time, the thinking indicator).
 *
 * THE CALLER CONTRACT MATTERS MORE THAN THE TICK: render a pure function of the
 * value this returns, and never call `Date.now()` inside render. kteam's
 * `useLiveTick.ts` learned it the hard way — the store coalesces stream events
 * at ~4/second, so a label that reads the clock itself mutates on every one of
 * those re-renders no matter how the tick behaves. A pure function of a stable
 * value produces byte-identical output, and React then writes nothing.
 *
 * That contract is also what makes the missing half cheap to add: kteam FREEZES
 * this value while the reader holds a text selection, because on WebKit a React
 * text write inside the selected element collapses the selection. The hold gate
 * (pointer + selection + a 20s cap) is a subsystem of its own and is NOT ported
 * yet; when it lands, it replaces the `hold` default below and every caller
 * already renders from the frozen value.
 */
export interface LiveClockOptions {
  /** Injectable so a test can drive the value instead of waiting on the wall. */
  readonly now?: () => number;
  readonly intervalMs?: number;
  /** While true the value stops advancing. Reserved for the transcript hold
   *  gate; callers do not pass it yet. */
  readonly hold?: boolean;
}

/** One second: fast enough that an elapsed counter looks live, slow enough that
 *  it is not a render budget. */
const TICK_MS = 1000;

export const useLiveClock = ({ now = Date.now, intervalMs = TICK_MS, hold }: LiveClockOptions = {}): number => {
  const transcriptHold = useTranscriptHold();
  const frozen = hold ?? transcriptHold;
  const [timestamp, setTimestamp] = useState(now);

  useEffect(() => {
    if (frozen) return undefined;
    // Catch up immediately on release, then keep ticking. The effect is
    // re-created when the hold flips, so no interval fires while frozen.
    setTimestamp(now());
    const timer = setInterval(() => setTimestamp(now()), intervalMs);
    return () => clearInterval(timer);
  }, [frozen, intervalMs, now]);

  return timestamp;
};
