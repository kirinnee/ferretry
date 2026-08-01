import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

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

/** A standing selection must never freeze the transcript indefinitely. */
export const MAX_TRANSCRIPT_HOLD_MS = 20_000;

/** WebKit may finish materialising a touch selection just after release. */
export const TOUCH_SELECTION_RELEASE_SETTLE_MS = 220;

/** A touch held this long is plausibly invoking native selection. */
export const TOUCH_SELECTION_DWELL_MS = 350;

/** Has the current uninterrupted hold reached its hard cap? */
export const holdExpired = (heldSince: number | null, now: number, capMs: number = MAX_TRANSCRIPT_HOLD_MS): boolean =>
  heldSince !== null && now - heldSince >= capMs;

/** The complete hold policy, kept pure so its boundaries are directly testable. */
export const shouldHoldStill = (
  pointerHeld: boolean,
  selection: TickSelectionLike | null,
  heldSince: number | null,
  now: number,
  capMs: number = MAX_TRANSCRIPT_HOLD_MS,
  releaseSettling = false,
): boolean => {
  const activelyHeld = transcriptHeldStill(pointerHeld, selection);
  // Settling may only extend a hold that already began; a stray release cannot
  // manufacture one.
  if (!activelyHeld && (!releaseSettling || heldSince === null)) return false;
  return !holdExpired(heldSince, now, capMs);
};

type HoldListener = () => void;

export interface TranscriptHoldEventLike {
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly touches?: { readonly length: number };
}

export interface TranscriptHoldListenerOptions {
  readonly capture?: boolean;
  readonly passive?: boolean;
}

type TranscriptHoldEventListener = (event: TranscriptHoldEventLike) => void;

/**
 * Injected document/window composition port. Controller state never reaches
 * for DOM globals, which keeps each test and browser document isolated.
 */
export interface TranscriptHoldDocument {
  getSelection(): TickSelectionLike | null;
  addEventListener(type: string, listener: TranscriptHoldEventListener, options?: TranscriptHoldListenerOptions): void;
  removeEventListener(
    type: string,
    listener: TranscriptHoldEventListener,
    options?: TranscriptHoldListenerOptions,
  ): void;
  addWindowEventListener(
    type: string,
    listener: TranscriptHoldEventListener,
    options?: TranscriptHoldListenerOptions,
  ): void;
  removeWindowEventListener(
    type: string,
    listener: TranscriptHoldEventListener,
    options?: TranscriptHoldListenerOptions,
  ): void;
}

export interface TranscriptHoldTiming {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface TranscriptHoldController {
  subscribe(listener: HoldListener): () => void;
  snapshot(): boolean;
}

export type TranscriptHoldDocumentProvider = () => TranscriptHoldDocument | undefined;

/** Adapt browser globals once at the composition seam. */
export const createBrowserTranscriptHoldPort = (
  documentLike: Pick<Document, 'addEventListener' | 'getSelection' | 'removeEventListener'> | undefined,
  windowLike: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined,
): TranscriptHoldDocument | undefined => {
  if (documentLike === undefined || windowLike === undefined) return undefined;
  return {
    getSelection: (): TickSelectionLike | null => documentLike.getSelection(),
    addEventListener: (type, listener, options): void =>
      documentLike.addEventListener(type, listener as EventListener, options as AddEventListenerOptions),
    removeEventListener: (type, listener, options): void =>
      documentLike.removeEventListener(type, listener as EventListener, options as EventListenerOptions),
    addWindowEventListener: (type, listener, options): void =>
      windowLike.addEventListener(type, listener as EventListener, options as AddEventListenerOptions),
    removeWindowEventListener: (type, listener, options): void =>
      windowLike.removeEventListener(type, listener as EventListener, options as EventListenerOptions),
  };
};

const browserTiming: TranscriptHoldTiming = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Creates one document-level hold controller. It tracks every active pointer,
 * de-duplicates Pointer Events plus legacy Touch Events, and bounds both the
 * release grace period and total hold duration.
 */
export const createTranscriptHoldController = (
  portSource: TranscriptHoldDocument | TranscriptHoldDocumentProvider | undefined,
  timing: TranscriptHoldTiming = browserTiming,
): TranscriptHoldController => {
  const listeners = new Set<HoldListener>();
  let port: TranscriptHoldDocument | undefined;
  let attached = false;
  let pointerDown = false;
  let pointerType = '';
  let pointerStartedAt: number | null = null;
  let selectionChangedDuringGesture = false;
  let mayRearmCappedSelection = false;
  let cancelledTouchPointerDuringGesture = false;
  const activePointerIds = new Set<number>();
  let activeLegacyTouches = 0;
  let heldSince: number | null = null;
  let holding = false;
  let capReached = false;
  let capTimer: unknown | null = null;
  let releaseSettling = false;
  let releaseTimer: unknown | null = null;

  const publish = (next: boolean): void => {
    if (next === holding) return;
    holding = next;
    for (const listener of listeners) listener();
  };

  const clearCapTimer = (): void => {
    if (capTimer === null) return;
    timing.clearTimer(capTimer);
    capTimer = null;
  };

  const clearReleaseSettle = (): void => {
    releaseSettling = false;
    if (releaseTimer === null) return;
    timing.clearTimer(releaseTimer);
    releaseTimer = null;
  };

  const expireHold = (): void => {
    clearCapTimer();
    heldSince = null;
    capReached = true;
    publish(false);
  };

  const recompute = (): void => {
    const selection = port?.getSelection() ?? null;
    const wants = transcriptHeldStill(pointerDown, selection) || releaseSettling;
    if (!wants) {
      heldSince = null;
      capReached = false;
      clearCapTimer();
      publish(false);
      return;
    }
    if (capReached) {
      publish(false);
      return;
    }
    if (heldSince === null) {
      heldSince = timing.now();
      capTimer = timing.setTimer(expireHold, MAX_TRANSCRIPT_HOLD_MS);
    }
    if (holdExpired(heldSince, timing.now())) {
      expireHold();
      return;
    }
    publish(shouldHoldStill(pointerDown, selection, heldSince, timing.now(), MAX_TRANSCRIPT_HOLD_MS, releaseSettling));
  };

  const beginPointer = (nextPointerType: string): void => {
    // Pointer Events and legacy Touch Events commonly describe the same start.
    if (pointerDown) return;
    clearReleaseSettle();
    const standingSelection = selectionHeld(port?.getSelection() ?? null);
    mayRearmCappedSelection = capReached && standingSelection;
    if (!standingSelection) {
      clearCapTimer();
      heldSince = null;
      capReached = false;
    }
    pointerDown = true;
    pointerType = nextPointerType;
    pointerStartedAt = timing.now();
    selectionChangedDuringGesture = false;
    cancelledTouchPointerDuringGesture = false;
    recompute();
  };

  const shouldSettleRelease = (endingPointerType: string): boolean => {
    const kind = pointerType || endingPointerType;
    if (kind === 'mouse') return false;
    const duration = pointerStartedAt === null ? 0 : Math.max(0, timing.now() - pointerStartedAt);
    return (
      duration >= TOUCH_SELECTION_DWELL_MS ||
      selectionChangedDuringGesture ||
      selectionHeld(port?.getSelection() ?? null)
    );
  };

  const endPointer = (endingPointerType: string): void => {
    // A pointerup followed by touchend is one release and keeps one deadline.
    if (!pointerDown) {
      recompute();
      return;
    }
    const settleRelease = cancelledTouchPointerDuringGesture || shouldSettleRelease(endingPointerType);
    pointerDown = false;
    pointerType = '';
    pointerStartedAt = null;
    selectionChangedDuringGesture = false;
    mayRearmCappedSelection = false;
    cancelledTouchPointerDuringGesture = false;
    activePointerIds.clear();
    activeLegacyTouches = 0;
    if (!settleRelease) {
      clearReleaseSettle();
      recompute();
      return;
    }
    releaseSettling = true;
    recompute();
    releaseTimer = timing.setTimer(() => {
      releaseTimer = null;
      releaseSettling = false;
      recompute();
    }, TOUCH_SELECTION_RELEASE_SETTLE_MS);
  };

  const onSelectionChange = (): void => {
    if (pointerDown) {
      selectionChangedDuringGesture = true;
      if (capReached && mayRearmCappedSelection) {
        clearCapTimer();
        heldSince = null;
        capReached = false;
        mayRearmCappedSelection = false;
      }
    }
    recompute();
  };

  const onPointerDown = (event: TranscriptHoldEventLike): void => {
    activePointerIds.add(event.pointerId ?? 0);
    activeLegacyTouches = 0;
    beginPointer(event.pointerType ?? '');
  };

  const onPointerUp = (event: TranscriptHoldEventLike): void => {
    activePointerIds.delete(event.pointerId ?? 0);
    if (activePointerIds.size > 0) {
      recompute();
      return;
    }
    endPointer(event.pointerType ?? '');
  };

  const onPointerCancel = (event: TranscriptHoldEventLike): void => {
    if (event.pointerType !== 'mouse') cancelledTouchPointerDuringGesture = true;
    activePointerIds.delete(event.pointerId ?? 0);
    if (activePointerIds.size > 0) {
      recompute();
      return;
    }
    endPointer(event.pointerType ?? '');
  };

  const onTouchStart = (event: TranscriptHoldEventLike): void => {
    if (activePointerIds.size > 0) return;
    activeLegacyTouches = Math.max(1, event.touches?.length ?? activeLegacyTouches + 1);
    beginPointer('touch');
  };

  const onTouchEnd = (event: TranscriptHoldEventLike): void => {
    if (activePointerIds.size > 0) return;
    activeLegacyTouches = event.touches?.length ?? Math.max(0, activeLegacyTouches - 1);
    if (activeLegacyTouches > 0) {
      recompute();
      return;
    }
    endPointer('touch');
  };

  const onBlur = (): void => {
    // Native selection UI may blur the page. Preserve an existing settle; if
    // blur replaces release, apply the same gesture evidence.
    if (releaseSettling) {
      recompute();
      return;
    }
    if (pointerDown) {
      activePointerIds.clear();
      activeLegacyTouches = 0;
      endPointer(pointerType);
      return;
    }
    activePointerIds.clear();
    activeLegacyTouches = 0;
    recompute();
  };

  const reset = (): void => {
    clearCapTimer();
    clearReleaseSettle();
    pointerDown = false;
    pointerType = '';
    pointerStartedAt = null;
    selectionChangedDuringGesture = false;
    mayRearmCappedSelection = false;
    cancelledTouchPointerDuringGesture = false;
    activePointerIds.clear();
    activeLegacyTouches = 0;
    heldSince = null;
    capReached = false;
    publish(false);
  };

  const passive = { passive: true };
  const capturePassive = { capture: true, passive: true };

  const attach = (): void => {
    if (attached) return;
    port = typeof portSource === 'function' ? portSource() : portSource;
    if (port === undefined) return;
    attached = true;
    port.addEventListener('selectionchange', onSelectionChange, passive);
    port.addEventListener('pointerdown', onPointerDown, capturePassive);
    port.addEventListener('touchstart', onTouchStart, passive);
    // Releases live on window so ending outside the start target cannot latch.
    port.addWindowEventListener('pointerup', onPointerUp, passive);
    port.addWindowEventListener('pointercancel', onPointerCancel, passive);
    port.addWindowEventListener('touchend', onTouchEnd, passive);
    port.addWindowEventListener('touchcancel', onTouchEnd, passive);
    port.addWindowEventListener('blur', onBlur, passive);
    port.addEventListener('visibilitychange', onBlur, passive);
    // A range may already be standing when the first consumer mounts (or
    // re-mounts after every previous subscriber detached).
    recompute();
  };

  const detach = (): void => {
    if (!attached || port === undefined) {
      port = undefined;
      reset();
      return;
    }
    attached = false;
    port.removeEventListener('selectionchange', onSelectionChange);
    port.removeEventListener('pointerdown', onPointerDown, { capture: true });
    port.removeEventListener('touchstart', onTouchStart);
    port.removeWindowEventListener('pointerup', onPointerUp);
    port.removeWindowEventListener('pointercancel', onPointerCancel);
    port.removeWindowEventListener('touchend', onTouchEnd);
    port.removeWindowEventListener('touchcancel', onTouchEnd);
    port.removeWindowEventListener('blur', onBlur);
    port.removeEventListener('visibilitychange', onBlur);
    reset();
    port = undefined;
  };

  return {
    subscribe: (listener: HoldListener): (() => void) => {
      // Each subscription gets its own entry, even when React reuses the same
      // callback identity for two consumers.
      const subscription = (): void => listener();
      const first = listeners.size === 0;
      listeners.add(subscription);
      if (first) attach();
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(subscription);
        if (listeners.size === 0) detach();
      };
    },
    snapshot: (): boolean => holding,
  };
};

// Production composition seam: browser globals are adapted exactly once.
const browserTranscriptHold = createTranscriptHoldController(() =>
  createBrowserTranscriptHoldPort(globalThis.document, globalThis.window),
);

/** Subscribe without React; kept public for DOM-free controller tests. */
export const subscribeTranscriptHold = browserTranscriptHold.subscribe;

const transcriptHoldSnapshot = browserTranscriptHold.snapshot;

/** One shared document-level selection/gesture gate. */
export const useTranscriptHold = (): boolean =>
  useSyncExternalStore(subscribeTranscriptHold, transcriptHoldSnapshot, () => false);

export interface LiveClockOptions {
  /** Injectable so a test can drive the value instead of waiting on the wall. */
  readonly now?: () => number;
  readonly intervalMs?: number;
  /** While true the value stops advancing. Explicit values override the shared gate. */
  readonly hold?: boolean;
}

const TICK_MS = 1000;

/** A live timestamp that freezes while transcript DOM must remain unchanged. */
export const useLiveClock = ({ now = Date.now, intervalMs = TICK_MS, hold }: LiveClockOptions = {}): number => {
  const transcriptHold = useTranscriptHold();
  const frozen = hold ?? transcriptHold;
  const nowRef = useRef(now);
  nowRef.current = now;
  const [timestamp, setTimestamp] = useState(now);

  useEffect(() => {
    if (frozen) return undefined;
    // Catch up immediately on release, then keep ticking.
    setTimestamp(nowRef.current());
    const timer = setInterval(() => setTimestamp(nowRef.current()), intervalMs);
    return () => clearInterval(timer);
  }, [frozen, intervalMs]);

  return timestamp;
};
