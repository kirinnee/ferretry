import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import '../support/dom.ts';
import {
  createBrowserTranscriptHoldPort,
  createTranscriptHoldController,
  holdExpired,
  MAX_TRANSCRIPT_HOLD_MS,
  selectionHeld,
  shouldHoldStill,
  type TickSelectionLike,
  TOUCH_SELECTION_DWELL_MS,
  TOUCH_SELECTION_RELEASE_SETTLE_MS,
  type TranscriptHoldDocument,
  type TranscriptHoldEventLike,
  type TranscriptHoldListenerOptions,
  type TranscriptHoldTiming,
  transcriptHeldStill,
  useLiveClock,
  useTranscriptHold,
} from '../../src/hooks/use-live-clock.ts';
import { render, run } from '../support/react.ts';

type Handler = (event: TranscriptHoldEventLike) => void;

interface Registration {
  readonly handler: Handler;
  readonly options?: TranscriptHoldListenerOptions;
}

interface VirtualTimer {
  readonly at: number;
  readonly callback: () => void;
}

const SELECTED: TickSelectionLike = { isCollapsed: false, rangeCount: 1 };
const DWELLING: TickSelectionLike = { isCollapsed: true, rangeCount: 1 };
const pointer = (pointerType: string, pointerId = 1): TranscriptHoldEventLike => ({ pointerId, pointerType });
const touches = (length: number): TranscriptHoldEventLike => ({ touches: { length } });

const addRegistration = (
  registrations: Map<string, Registration[]>,
  type: string,
  handler: Handler,
  options?: TranscriptHoldListenerOptions,
): void => {
  const current = registrations.get(type) ?? [];
  current.push({ handler, options });
  registrations.set(type, current);
};

const removeRegistration = (registrations: Map<string, Registration[]>, type: string, handler: Handler): void => {
  const current = registrations.get(type) ?? [];
  registrations.set(
    type,
    current.filter(registration => registration.handler !== handler),
  );
};

const dispatch = (
  registrations: Map<string, Registration[]>,
  type: string,
  event: TranscriptHoldEventLike = {},
): void => {
  for (const registration of [...(registrations.get(type) ?? [])]) registration.handler(event);
};

function controllerHarness(autoSubscribe = true) {
  let now = 0;
  let nextTimer = 1;
  let selection: TickSelectionLike | null = null;
  const timers = new Map<number, VirtualTimer>();
  const clearedTimers: number[] = [];
  const documentListeners = new Map<string, Registration[]>();
  const windowListeners = new Map<string, Registration[]>();
  const removedDocumentListeners: string[] = [];
  const removedWindowListeners: string[] = [];
  const port: TranscriptHoldDocument = {
    getSelection: () => selection,
    addEventListener: (type, handler, options) => addRegistration(documentListeners, type, handler, options),
    removeEventListener: (type, handler) => {
      removedDocumentListeners.push(type);
      removeRegistration(documentListeners, type, handler);
    },
    addWindowEventListener: (type, handler, options) => addRegistration(windowListeners, type, handler, options),
    removeWindowEventListener: (type, handler) => {
      removedWindowListeners.push(type);
      removeRegistration(windowListeners, type, handler);
    },
  };
  const timing: TranscriptHoldTiming = {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer: timer => {
      const id = timer as number;
      clearedTimers.push(id);
      timers.delete(id);
    },
  };
  const controller = createTranscriptHoldController(port, timing);
  const changes: boolean[] = [];
  const subscriptions: Array<() => void> = [];
  const subscribe = (record: boolean[] = changes): (() => void) => {
    const unsubscribe = controller.subscribe(() => record.push(controller.snapshot()));
    subscriptions.push(unsubscribe);
    return unsubscribe;
  };
  if (autoSubscribe) subscribe();

  const advance = (durationMs: number): void => {
    const target = now + durationMs;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    now = target;
  };

  return {
    advance,
    changes,
    clearedTimers,
    controller,
    documentListeners,
    windowListeners,
    removedDocumentListeners,
    removedWindowListeners,
    timers,
    timing,
    port,
    subscribe,
    unsubscribe: (): void => subscriptions.shift()?.(),
    documentEvent: (type: string, event?: TranscriptHoldEventLike): void => dispatch(documentListeners, type, event),
    windowEvent: (type: string, event?: TranscriptHoldEventLike): void => dispatch(windowListeners, type, event),
    setSelection: (next: TickSelectionLike | null): void => {
      selection = next;
    },
    jumpWithoutTimers: (durationMs: number): void => {
      now += durationMs;
    },
  };
}

describe('transcript hold policy', () => {
  test('distinguishes a real range from null, a caret, and an empty selection', () => {
    expect(selectionHeld(null)).toBeFalse();
    expect(selectionHeld({ isCollapsed: true, rangeCount: 1 })).toBeFalse();
    expect(selectionHeld({ isCollapsed: false, rangeCount: 0 })).toBeFalse();
    expect(selectionHeld({ isCollapsed: true, rangeCount: 0 })).toBeFalse();
    expect(selectionHeld(SELECTED)).toBeTrue();

    expect(transcriptHeldStill(false, null)).toBeFalse();
    expect(transcriptHeldStill(false, SELECTED)).toBeTrue();
    expect(transcriptHeldStill(true, DWELLING)).toBeTrue();
    expect(transcriptHeldStill(true, null)).toBeTrue();
  });

  test('caps active and settling holds at the same explicit boundary', () => {
    expect(TOUCH_SELECTION_RELEASE_SETTLE_MS).toBeGreaterThanOrEqual(200);
    expect(TOUCH_SELECTION_RELEASE_SETTLE_MS).toBeLessThanOrEqual(300);

    expect(holdExpired(null, 1_000_000)).toBeFalse();
    expect(holdExpired(1_000, 1_000 + MAX_TRANSCRIPT_HOLD_MS - 1)).toBeFalse();
    expect(holdExpired(1_000, 1_000 + MAX_TRANSCRIPT_HOLD_MS)).toBeTrue();
    expect(holdExpired(0, 500, 400)).toBeTrue();

    expect(shouldHoldStill(false, null, null, 5_000)).toBeFalse();
    expect(shouldHoldStill(false, SELECTED, 4_000, 5_000)).toBeTrue();
    expect(shouldHoldStill(true, DWELLING, 4_000, 5_000)).toBeTrue();
    expect(shouldHoldStill(false, SELECTED, 0, MAX_TRANSCRIPT_HOLD_MS)).toBeFalse();
    expect(shouldHoldStill(false, DWELLING, 0, 1, MAX_TRANSCRIPT_HOLD_MS, true)).toBeTrue();
    expect(shouldHoldStill(false, DWELLING, null, 1, MAX_TRANSCRIPT_HOLD_MS, true)).toBeFalse();
    expect(shouldHoldStill(false, DWELLING, 0, 500, 400, true)).toBeFalse();
  });
});

describe('transcript hold controller gestures', () => {
  test('releases a quick touch immediately but settles a plausible long-press', () => {
    const h = controllerHarness();
    h.documentEvent('pointerdown', pointer('touch'));
    expect(h.controller.snapshot()).toBeTrue();
    expect(h.timers.size).toBe(1);

    h.advance(60);
    h.windowEvent('pointerup', pointer('touch'));
    expect(h.controller.snapshot()).toBeFalse();
    expect(h.timers.size).toBe(0);

    h.documentEvent('pointerdown', pointer('pen', 2));
    h.advance(TOUCH_SELECTION_DWELL_MS);
    h.windowEvent('pointerup', pointer('pen', 2));
    expect(h.controller.snapshot()).toBeTrue();
    expect(h.timers.size).toBe(2);
    h.advance(TOUCH_SELECTION_RELEASE_SETTLE_MS - 1);
    expect(h.controller.snapshot()).toBeTrue();
    h.advance(1);
    expect(h.controller.snapshot()).toBeFalse();
    expect(h.timers.size).toBe(0);
  });

  test('mouse release is immediate even after a long press, while a finished range owns the hold', () => {
    const h = controllerHarness();
    h.documentEvent('pointerdown', pointer('mouse'));
    h.advance(TOUCH_SELECTION_DWELL_MS * 2);
    h.windowEvent('pointerup', pointer('mouse'));
    expect(h.controller.snapshot()).toBeFalse();

    h.documentEvent('pointerdown', pointer('mouse', 2));
    h.setSelection(SELECTED);
    h.documentEvent('selectionchange');
    h.windowEvent('pointerup', pointer('mouse', 2));
    expect(h.controller.snapshot()).toBeTrue();
    h.setSelection(null);
    h.documentEvent('selectionchange');
    expect(h.controller.snapshot()).toBeFalse();
  });

  test('selection-change evidence settles a short legacy touch release', () => {
    const h = controllerHarness();
    h.documentEvent('touchstart', touches(1));
    h.advance(60);
    h.setSelection(DWELLING);
    h.documentEvent('selectionchange');
    h.windowEvent('touchend', touches(0));
    expect(h.controller.snapshot()).toBeTrue();
    h.advance(TOUCH_SELECTION_RELEASE_SETTLE_MS);
    expect(h.controller.snapshot()).toBeFalse();
  });

  test('pointer and legacy touch events for one gesture do not double-count or restart settling', () => {
    const h = controllerHarness();
    h.documentEvent('pointerdown', pointer('touch'));
    h.advance(100);
    h.documentEvent('touchstart', touches(1));
    h.advance(TOUCH_SELECTION_DWELL_MS - 100);
    h.windowEvent('pointerup', pointer('touch'));
    h.advance(80);
    h.windowEvent('touchend', touches(0));
    h.windowEvent('blur');
    h.advance(TOUCH_SELECTION_RELEASE_SETTLE_MS - 81);
    expect(h.controller.snapshot()).toBeTrue();
    h.advance(1);
    expect(h.controller.snapshot()).toBeFalse();
  });

  test('multi-pointer and legacy multi-touch release only after the last contact', () => {
    const pointerHarness = controllerHarness();
    pointerHarness.documentEvent('pointerdown', pointer('touch', 1));
    pointerHarness.advance(100);
    pointerHarness.documentEvent('pointerdown', pointer('touch', 2));
    pointerHarness.advance(50);
    pointerHarness.windowEvent('pointerup', pointer('touch', 2));
    expect(pointerHarness.controller.snapshot()).toBeTrue();
    pointerHarness.advance(400);
    pointerHarness.windowEvent('pointerup', pointer('touch', 1));
    expect(pointerHarness.controller.snapshot()).toBeTrue();
    pointerHarness.advance(TOUCH_SELECTION_RELEASE_SETTLE_MS);
    expect(pointerHarness.controller.snapshot()).toBeFalse();

    const cancelHarness = controllerHarness();
    cancelHarness.documentEvent('pointerdown', pointer('touch', 1));
    cancelHarness.documentEvent('pointerdown', pointer('touch', 2));
    cancelHarness.windowEvent('pointercancel', pointer('touch', 2));
    expect(cancelHarness.controller.snapshot()).toBeTrue();
    cancelHarness.windowEvent('pointerup', pointer('touch', 1));
    expect(cancelHarness.controller.snapshot()).toBeTrue();
    cancelHarness.advance(TOUCH_SELECTION_RELEASE_SETTLE_MS);
    expect(cancelHarness.controller.snapshot()).toBeFalse();

    const touchHarness = controllerHarness();
    touchHarness.documentEvent('touchstart', touches(1));
    touchHarness.documentEvent('touchstart', touches(2));
    touchHarness.advance(TOUCH_SELECTION_DWELL_MS);
    touchHarness.windowEvent('touchend', touches(1));
    expect(touchHarness.controller.snapshot()).toBeTrue();
    touchHarness.windowEvent('touchend', touches(0));
    expect(touchHarness.controller.snapshot()).toBeTrue();
    touchHarness.advance(TOUCH_SELECTION_RELEASE_SETTLE_MS);
    expect(touchHarness.controller.snapshot()).toBeFalse();
  });

  test('legacy touch fallback also counts contacts when a touches list is absent', () => {
    const h = controllerHarness();
    h.documentEvent('touchstart');
    h.documentEvent('touchstart');
    h.advance(TOUCH_SELECTION_DWELL_MS);
    h.windowEvent('touchend');
    expect(h.controller.snapshot()).toBeTrue();
    h.windowEvent('touchcancel');
    expect(h.controller.snapshot()).toBeTrue();
    h.advance(TOUCH_SELECTION_RELEASE_SETTLE_MS);
    expect(h.controller.snapshot()).toBeFalse();
  });

  test('touch pointercancel settles below dwell; mouse cancel and quick blur release immediately', () => {
    const h = controllerHarness();
    h.documentEvent('pointerdown', pointer('touch'));
    h.advance(100);
    h.windowEvent('pointercancel', pointer('touch'));
    expect(h.controller.snapshot()).toBeTrue();
    h.advance(TOUCH_SELECTION_RELEASE_SETTLE_MS);
    expect(h.controller.snapshot()).toBeFalse();

    h.documentEvent('pointerdown', pointer('mouse', 2));
    h.windowEvent('pointercancel', pointer('mouse', 2));
    expect(h.controller.snapshot()).toBeFalse();

    h.documentEvent('pointerdown', pointer('touch', 3));
    h.advance(40);
    h.windowEvent('blur');
    expect(h.controller.snapshot()).toBeFalse();
  });

  test('visibility loss releases an active mouse gesture and idle blur preserves a selection hold', () => {
    const h = controllerHarness();
    h.documentEvent('pointerdown', pointer('mouse'));
    h.documentEvent('visibilitychange');
    expect(h.controller.snapshot()).toBeFalse();

    h.setSelection(SELECTED);
    h.documentEvent('selectionchange');
    h.windowEvent('blur');
    expect(h.controller.snapshot()).toBeTrue();
    h.setSelection(null);
    h.documentEvent('visibilitychange');
    expect(h.controller.snapshot()).toBeFalse();
  });
});

describe('bounded selection episodes', () => {
  test('an event also enforces a deadline whose timer callback has not run yet', () => {
    const h = controllerHarness();
    h.documentEvent('pointerdown', pointer('mouse'));
    h.jumpWithoutTimers(MAX_TRANSCRIPT_HOLD_MS);
    h.documentEvent('selectionchange');
    expect(h.controller.snapshot()).toBeFalse();
    expect(h.timers.size).toBe(0);
  });

  test('the hard cap releases a gesture and selection changes from that gesture cannot restart it', () => {
    const h = controllerHarness();
    h.documentEvent('pointerdown', pointer('touch'));
    h.advance(MAX_TRANSCRIPT_HOLD_MS);
    expect(h.controller.snapshot()).toBeFalse();
    expect(h.timers.size).toBe(0);

    h.setSelection(DWELLING);
    h.documentEvent('selectionchange');
    expect(h.controller.snapshot()).toBeFalse();
    h.windowEvent('pointerup', pointer('touch'));

    h.setSelection(null);
    h.documentEvent('pointerdown', pointer('touch', 2));
    expect(h.controller.snapshot()).toBeTrue();
    h.advance(MAX_TRANSCRIPT_HOLD_MS - 1);
    expect(h.controller.snapshot()).toBeTrue();
  });

  test('unrelated taps cannot renew the cap of a standing selection', () => {
    const h = controllerHarness();
    h.setSelection(SELECTED);
    h.documentEvent('selectionchange');
    for (let tap = 1; tap <= 3; tap += 1) {
      h.advance(tap === 1 ? 5_000 : 4_950);
      h.documentEvent('pointerdown', pointer('touch', tap));
      h.advance(50);
      h.windowEvent('pointerup', pointer('touch', tap));
      expect(h.controller.snapshot()).toBeTrue();
    }
    h.advance(4_950);
    expect(h.controller.snapshot()).toBeFalse();

    h.documentEvent('pointerdown', pointer('touch', 9));
    h.windowEvent('pointerup', pointer('touch', 9));
    expect(h.controller.snapshot()).toBeFalse();
  });

  test('in-gesture selection evidence legitimately re-arms a previously capped standing range', () => {
    const h = controllerHarness();
    h.setSelection(SELECTED);
    h.documentEvent('selectionchange');
    h.advance(MAX_TRANSCRIPT_HOLD_MS);
    expect(h.controller.snapshot()).toBeFalse();

    h.documentEvent('pointerdown', pointer('touch'));
    expect(h.controller.snapshot()).toBeFalse();
    h.setSelection(DWELLING);
    h.documentEvent('selectionchange');
    expect(h.controller.snapshot()).toBeTrue();
    h.advance(TOUCH_SELECTION_DWELL_MS);
    h.windowEvent('pointerup', pointer('touch'));
    h.advance(100);
    h.setSelection(SELECTED);
    h.documentEvent('selectionchange');
    h.advance(TOUCH_SELECTION_RELEASE_SETTLE_MS - 100);
    expect(h.controller.snapshot()).toBeTrue();
  });

  test('many overlapping dwell settles and quick flings cannot poison a later hold', () => {
    const h = controllerHarness();
    for (let gesture = 0; gesture < 60; gesture += 1) {
      h.documentEvent('pointerdown', pointer('touch', gesture));
      h.advance(400);
      h.windowEvent('pointerup', pointer('touch', gesture));
      h.advance(100);
      expect(h.timers.size).toBeLessThanOrEqual(2);
    }
    for (let gesture = 60; gesture < 300; gesture += 1) {
      h.documentEvent('pointerdown', pointer('touch', gesture));
      h.advance(60);
      h.windowEvent('pointerup', pointer('touch', gesture));
      h.advance(90);
      expect(h.timers.size).toBe(0);
    }
    h.documentEvent('pointerdown', pointer('touch', 999));
    h.advance(TOUCH_SELECTION_DWELL_MS);
    h.windowEvent('pointerup', pointer('touch', 999));
    expect(h.controller.snapshot()).toBeTrue();
    expect(h.timers.size).toBe(2);
  });
});

describe('injected browser composition and lifecycle', () => {
  test('the server snapshot never claims a browser-only hold', () => {
    const HoldProbe = () => createElement('span', null, String(useTranscriptHold()));
    expect(renderToString(createElement(HoldProbe))).toBe('<span>false</span>');
  });

  test('attaches once, releases on window, detaches on the last unsubscribe, and clears timers', () => {
    const h = controllerHarness(false);
    const firstChanges: boolean[] = [];
    const secondChanges: boolean[] = [];
    const unsubscribeFirst = h.subscribe(firstChanges);
    const unsubscribeSecond = h.subscribe(secondChanges);

    expect([...h.documentListeners.keys()].sort()).toEqual([
      'pointerdown',
      'selectionchange',
      'touchstart',
      'visibilitychange',
    ]);
    expect([...h.windowListeners.keys()].sort()).toEqual([
      'blur',
      'pointercancel',
      'pointerup',
      'touchcancel',
      'touchend',
    ]);
    expect(h.documentListeners.get('pointerdown')?.[0]?.options).toEqual({ capture: true, passive: true });

    h.documentEvent('pointerdown', pointer('touch'));
    expect(firstChanges).toEqual([true]);
    expect(secondChanges).toEqual([true]);
    unsubscribeFirst();
    expect(h.documentListeners.get('pointerdown')).toHaveLength(1);
    unsubscribeSecond();

    expect(h.controller.snapshot()).toBeFalse();
    expect(h.timers.size).toBe(0);
    expect(h.removedDocumentListeners.sort()).toEqual([
      'pointerdown',
      'selectionchange',
      'touchstart',
      'visibilitychange',
    ]);
    expect(h.removedWindowListeners.sort()).toEqual(['blur', 'pointercancel', 'pointerup', 'touchcancel', 'touchend']);
    unsubscribeSecond();
  });

  test('re-attaches cleanly after teardown and an undefined SSR port is inert', () => {
    const h = controllerHarness(false);
    const first = h.subscribe();
    first();
    const second = h.subscribe();
    h.documentEvent('pointerdown', pointer('mouse'));
    expect(h.controller.snapshot()).toBeTrue();
    second();
    expect(h.controller.snapshot()).toBeFalse();

    const serverController = createTranscriptHoldController(undefined, {
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    const unsubscribe = serverController.subscribe(() => {
      throw new Error('an SSR controller cannot publish');
    });
    expect(serverController.snapshot()).toBeFalse();
    unsubscribe();

    const lazyHarness = controllerHarness(false);
    let available = false;
    const lazyController = createTranscriptHoldController(
      () => (available ? lazyHarness.port : undefined),
      lazyHarness.timing,
    );
    const unavailableSubscription = lazyController.subscribe(() => undefined);
    expect(lazyHarness.documentListeners.size).toBe(0);
    unavailableSubscription();
    available = true;
    const availableSubscription = lazyController.subscribe(() => undefined);
    expect(lazyHarness.documentListeners.get('pointerdown')).toHaveLength(1);
    availableSubscription();
  });

  test('samples a selection that was already standing before the first subscriber', () => {
    const h = controllerHarness(false);
    h.setSelection(SELECTED);
    const unsubscribe = h.subscribe();
    expect(h.controller.snapshot()).toBeTrue();
    expect(h.timers.size).toBe(1);
    unsubscribe();
    expect(h.timers.size).toBe(0);
  });

  test('adapts document and window targets without changing listener identity', () => {
    let selection: TickSelectionLike | null = null;
    const documentListeners = new Map<string, Registration[]>();
    const windowListeners = new Map<string, Registration[]>();
    const removedDocumentHandlers: Handler[] = [];
    const removedWindowHandlers: Handler[] = [];

    const documentLike = {
      getSelection: () => selection,
      addEventListener: (type: string, listener: EventListener, options?: AddEventListenerOptions) =>
        addRegistration(documentListeners, type, listener as Handler, options),
      removeEventListener: (type: string, listener: EventListener) => {
        removedDocumentHandlers.push(listener as Handler);
        removeRegistration(documentListeners, type, listener as Handler);
      },
    } as unknown as Pick<Document, 'addEventListener' | 'getSelection' | 'removeEventListener'>;
    const windowLike = {
      addEventListener: (type: string, listener: EventListener, options?: AddEventListenerOptions) =>
        addRegistration(windowListeners, type, listener as Handler, options),
      removeEventListener: (type: string, listener: EventListener) => {
        removedWindowHandlers.push(listener as Handler);
        removeRegistration(windowListeners, type, listener as Handler);
      },
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;

    expect(createBrowserTranscriptHoldPort(undefined, windowLike)).toBeUndefined();
    expect(createBrowserTranscriptHoldPort(documentLike, undefined)).toBeUndefined();
    const port = createBrowserTranscriptHoldPort(documentLike, windowLike);
    const controller = createTranscriptHoldController(port, {
      now: () => 0,
      setTimer: (callback, delayMs) => ({ callback, delayMs }),
      clearTimer: () => undefined,
    });
    const unsubscribe = controller.subscribe(() => undefined);
    dispatch(documentListeners, 'pointerdown', pointer('mouse'));
    expect(controller.snapshot()).toBeTrue();
    dispatch(windowListeners, 'pointerup', pointer('mouse'));
    expect(controller.snapshot()).toBeFalse();
    selection = SELECTED;
    dispatch(documentListeners, 'selectionchange');
    expect(port?.getSelection()).toBe(SELECTED);

    const attachedDocumentHandlers = [...documentListeners.values()].flat().map(({ handler }) => handler);
    const attachedWindowHandlers = [...windowListeners.values()].flat().map(({ handler }) => handler);
    unsubscribe();
    expect(removedDocumentHandlers).toEqual(attachedDocumentHandlers);
    expect(removedWindowHandlers).toEqual(attachedWindowHandlers);
  });

  test('the production timing default schedules and clears a bounded cap without waiting', () => {
    const h = controllerHarness(false);
    const controller = createTranscriptHoldController({
      getSelection: () => null,
      addEventListener: (type, handler, options) => addRegistration(h.documentListeners, type, handler, options),
      removeEventListener: (type, handler) => removeRegistration(h.documentListeners, type, handler),
      addWindowEventListener: (type, handler, options) => addRegistration(h.windowListeners, type, handler, options),
      removeWindowEventListener: (type, handler) => removeRegistration(h.windowListeners, type, handler),
    });
    const unsubscribe = controller.subscribe(() => undefined);
    dispatch(h.documentListeners, 'pointerdown', pointer('mouse'));
    expect(controller.snapshot()).toBeTrue();
    unsubscribe();
    expect(controller.snapshot()).toBeFalse();
  });
});

function LiveClockProbe({ now, hold }: { readonly now: () => number; readonly hold?: boolean }) {
  const timestamp = useLiveClock({ now, intervalMs: 1_000, hold });
  const transcriptHold = useTranscriptHold();
  return createElement('span', null, `${timestamp}:${transcriptHold}`);
}

describe('useLiveClock injection', () => {
  test('a fresh now callback does not restart the interval and explicit false overrides the shared hold', () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const intervals = new Map<number, () => void>();
    let nextInterval = 1;
    let intervalsStarted = 0;
    let intervalsCleared = 0;
    let timestamp = 10;

    globalThis.setInterval = ((callback: TimerHandler) => {
      if (typeof callback !== 'function') throw new Error('the live clock must schedule a function');
      const id = nextInterval;
      nextInterval += 1;
      intervalsStarted += 1;
      intervals.set(id, callback as () => void);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = (timer => {
      intervalsCleared += 1;
      intervals.delete(timer as number);
    }) as typeof clearInterval;

    const selection = window.getSelection();
    selection?.removeAllRanges();
    const target = document.createElement('button');
    target.addEventListener('pointerdown', event => event.stopPropagation());
    document.body.appendChild(target);

    let clock: ReturnType<typeof render> | undefined;
    try {
      clock = render(createElement(LiveClockProbe, { hold: false, now: () => timestamp }));
      expect(clock.root.findByType('span').children.join('')).toBe('10:false');
      expect(intervalsStarted).toBe(1);

      const down = Object.assign(new Event('pointerdown', { bubbles: true }), {
        pointerId: 1,
        pointerType: 'touch',
      });
      run(() => target.dispatchEvent(down));
      expect(clock.root.findByType('span').children.join('')).toBe('10:true');

      run(() => clock?.update(createElement(LiveClockProbe, { hold: false, now: () => timestamp })));
      expect(intervalsStarted).toBe(1);
      expect(intervalsCleared).toBe(0);

      timestamp = 25;
      run(() => {
        for (const callback of intervals.values()) callback();
      });
      expect(clock.root.findByType('span').children.join('')).toBe('25:true');
    } finally {
      if (clock !== undefined) run(() => clock?.unmount());
      target.remove();
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }

    expect(intervals.size).toBe(0);
    expect(intervalsCleared).toBe(1);
  });
});
