import { useSyncExternalStore } from 'react';

/** Input capability is deliberately independent from the viewport. */
export interface InputModalityState {
  readonly touchAffected: boolean;
  readonly enterSends: boolean;
}

export interface InputModalitySignals {
  readonly finePrimary: boolean | null;
  readonly coarsePrimary: boolean | null;
  readonly hoverPrimary: boolean | null;
  readonly noHoverPrimary: boolean | null;
  readonly anyCoarse: boolean | null;
  readonly lastPointerType: string | null;
}

const CONSERVATIVE_STATE: InputModalityState = { touchAffected: true, enterSends: false };

const MEDIA_QUERIES = {
  finePrimary: '(pointer: fine)',
  coarsePrimary: '(pointer: coarse)',
  hoverPrimary: '(hover: hover)',
  noHoverPrimary: '(hover: none)',
  anyCoarse: '(any-pointer: coarse)',
} as const;

type MediaSignal = keyof typeof MEDIA_QUERIES;

/** A device with any ambiguity keeps touch-safe controls and does not send on bare Enter. */
export function resolveInputModality(signals: InputModalitySignals): InputModalityState {
  const primaryIsFine = signals.finePrimary === true && signals.coarsePrimary === false;
  const primaryCanHover = signals.hoverPrimary === true && signals.noHoverPrimary === false;
  const mouseOrBoot = signals.lastPointerType === null || signals.lastPointerType === 'mouse';
  return {
    enterSends: primaryIsFine && primaryCanHover && mouseOrBoot,
    touchAffected:
      signals.finePrimary !== true ||
      signals.coarsePrimary !== false ||
      signals.hoverPrimary !== true ||
      signals.noHoverPrimary !== false ||
      signals.anyCoarse !== false ||
      !mouseOrBoot,
  };
}

interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
  addListener?(listener: () => void): void;
  removeListener?(listener: () => void): void;
}

interface PointerLike {
  readonly pointerType?: string;
}

/** Port for browser capabilities; tests provide a small fake rather than reaching global APIs. */
export interface InputModalitySource {
  matchMedia(query: string): MediaQueryListLike;
  addPointerListener(listener: (event: PointerLike) => void): void;
  removePointerListener(listener: (event: PointerLike) => void): void;
}

export interface InputModalityStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): InputModalityState;
  read(): InputModalityState;
  dispose(): void;
}

/** One shared store owns global listeners, including across StrictMode subscription cycles. */
export function createInputModalityStore(sourceProvider: () => InputModalitySource | null): InputModalityStore {
  const subscribers = new Set<() => void>();
  const media = new Map<MediaSignal, MediaQueryListLike>();
  const mediaCleanups: Array<() => void> = [];
  let source: InputModalitySource | null = null;
  let started = false;
  let lastPointerType: string | null = null;
  let snapshot = CONSERVATIVE_STATE;

  const refresh = (): void => {
    const readSignal = (signal: MediaSignal): boolean | null => {
      try {
        return media.get(signal)?.matches ?? null;
      } catch {
        return null;
      }
    };
    const next = resolveInputModality({
      finePrimary: readSignal('finePrimary'),
      coarsePrimary: readSignal('coarsePrimary'),
      hoverPrimary: readSignal('hoverPrimary'),
      noHoverPrimary: readSignal('noHoverPrimary'),
      anyCoarse: readSignal('anyCoarse'),
      lastPointerType,
    });
    if (next.touchAffected === snapshot.touchAffected && next.enterSends === snapshot.enterSends) return;
    snapshot = next;
    for (const subscriber of subscribers) subscriber();
  };

  const onMediaChange = (): void => refresh();
  const onPointerDown = (event: PointerLike): void => {
    lastPointerType = event.pointerType || 'unknown';
    refresh();
  };

  const start = (): void => {
    if (started) return;
    source = sourceProvider();
    if (source === null) return;
    started = true;
    for (const signal of Object.keys(MEDIA_QUERIES) as MediaSignal[]) {
      try {
        const query = source.matchMedia(MEDIA_QUERIES[signal]);
        media.set(signal, query);
        if (typeof query.addEventListener === 'function') {
          query.addEventListener('change', onMediaChange);
          mediaCleanups.push(() => query.removeEventListener?.('change', onMediaChange));
        } else if (typeof query.addListener === 'function') {
          query.addListener(onMediaChange);
          mediaCleanups.push(() => query.removeListener?.(onMediaChange));
        }
      } catch {
        // Failed probes remain unknown, which is the conservative policy input.
      }
    }
    try {
      source.addPointerListener(onPointerDown);
    } catch {
      // Missing pointer events leave media signals as the safe fallback.
    }
    refresh();
  };

  return {
    subscribe(listener) {
      subscribers.add(listener);
      start();
      return () => subscribers.delete(listener);
    },
    getSnapshot: () => snapshot,
    read() {
      start();
      return snapshot;
    },
    dispose() {
      for (const cleanup of mediaCleanups.splice(0)) cleanup();
      if (started && source !== null) {
        try {
          source.removePointerListener(onPointerDown);
        } catch {
          // A partial browser/test port may fail to remove; reset remains deterministic.
        }
      }
      subscribers.clear();
      media.clear();
      source = null;
      started = false;
      lastPointerType = null;
      snapshot = CONSERVATIVE_STATE;
    },
  };
}

const browserSource = (): InputModalitySource | null => {
  if (typeof window === 'undefined') return null;
  return {
    matchMedia(query) {
      if (typeof window.matchMedia !== 'function') throw new Error('matchMedia unavailable');
      return window.matchMedia(query);
    },
    addPointerListener(listener) {
      window.addEventListener('pointerdown', listener as EventListener, { capture: true, passive: true });
    },
    removePointerListener(listener) {
      window.removeEventListener('pointerdown', listener as EventListener, true);
    },
  };
};

const inputModalityStore = createInputModalityStore(browserSource);
inputModalityStore.read();

/** Synchronous read for safety-sensitive event handlers. */
export const readInputModality = (): InputModalityState => inputModalityStore.read();

export const useInputModality = (): InputModalityState =>
  useSyncExternalStore(inputModalityStore.subscribe, inputModalityStore.getSnapshot, () => CONSERVATIVE_STATE);
