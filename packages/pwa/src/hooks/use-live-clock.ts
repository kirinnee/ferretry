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

export interface TranscriptHoldDocument {
  getSelection(): TickSelectionLike | null;
  addEventListener(type: string, listener: (event: { readonly pointerType?: string }) => void): void;
  addWindowEventListener(type: 'blur', listener: () => void): void;
}

export interface TranscriptHoldController {
  subscribe(listener: HoldListener): () => void;
  snapshot(): boolean;
}

/** Adapt browser globals at the composition seam without making them controller state. */
export const createBrowserTranscriptHoldPort = (
  documentLike: Pick<Document, 'addEventListener' | 'getSelection'> | undefined,
  windowLike: Pick<Window, 'addEventListener'> | undefined,
): TranscriptHoldDocument | undefined => {
  if (documentLike === undefined || windowLike === undefined) return undefined;
  return {
    getSelection: (): TickSelectionLike | null => documentLike.getSelection(),
    addEventListener: (type: string, listener: (event: { readonly pointerType?: string }) => void): void =>
      documentLike.addEventListener(type, event => listener(event as PointerEvent)),
    addWindowEventListener: (type: 'blur', listener: () => void): void => windowLike.addEventListener(type, listener),
  };
};

/**
 * Creates one document-level hold controller. Keeping its mutable gesture
 * state inside this closure makes the browser document an explicit dependency
 * and lets each DOM test own an isolated controller.
 */
export const createTranscriptHoldController = (port: TranscriptHoldDocument | undefined): TranscriptHoldController => {
  const listeners = new Set<HoldListener>();
  let attached = false;
  let pointerHeld = false;
  let holding = false;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  const publishHold = (): void => {
    const next = transcriptHeldStill(pointerHeld, port?.getSelection() ?? null);
    if (next === holding) return;
    holding = next;
    for (const listener of listeners) listener();
  };

  const clearHoldTimers = (): void => {
    if (capTimer !== undefined) clearTimeout(capTimer);
    if (releaseTimer !== undefined) clearTimeout(releaseTimer);
    capTimer = undefined;
    releaseTimer = undefined;
  };

  const attach = (): void => {
    if (attached || port === undefined) return;
    attached = true;
    const hold = (): void => {
      pointerHeld = true;
      clearHoldTimers();
      capTimer = setTimeout(() => {
        pointerHeld = false;
        publishHold();
      }, MAX_TRANSCRIPT_HOLD_MS);
      publishHold();
    };
    const release = (event: { readonly pointerType?: string }): void => {
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
    port.addEventListener('selectionchange', publishHold);
    port.addEventListener('pointerdown', hold);
    port.addEventListener('pointerup', release);
    port.addEventListener('pointercancel', release);
    port.addWindowEventListener('blur', () => {
      pointerHeld = false;
      clearHoldTimers();
      publishHold();
    });
  };

  return {
    subscribe: (listener: HoldListener): (() => void) => {
      listeners.add(listener);
      attach();
      return () => listeners.delete(listener);
    },
    snapshot: (): boolean => holding,
  };
};

// Production composition seam: browser globals are adapted once here.
const browserTranscriptHold = createTranscriptHoldController(
  createBrowserTranscriptHoldPort(globalThis.document, globalThis.window),
);

/** Subscribe without React; kept public for DOM-free controller tests. */
export const subscribeTranscriptHold = browserTranscriptHold.subscribe;

const transcriptHoldSnapshot = browserTranscriptHold.snapshot;

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
