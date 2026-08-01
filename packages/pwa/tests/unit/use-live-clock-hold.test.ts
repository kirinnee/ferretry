import { afterEach, describe, expect, test } from 'bun:test';
import {
  createBrowserTranscriptHoldPort,
  createTranscriptHoldController,
  MAX_TRANSCRIPT_HOLD_MS,
  TOUCH_SELECTION_RELEASE_SETTLE_MS,
} from '../../src/hooks/use-live-clock.ts';

type Handler = (event: { readonly pointerType?: string }) => void;
const handlers = new Map<string, Handler>();
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  handlers.clear();
});

describe('the transcript hold controller', () => {
  test('releases a pointer gesture at its hard cap', async () => {
    const document = {
      getSelection: () => null,
      addEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
      addWindowEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
    };
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...arguments_: unknown[]) =>
      delay === MAX_TRANSCRIPT_HOLD_MS
        ? originalSetTimeout(callback, 0, ...arguments_)
        : originalSetTimeout(callback, delay, ...arguments_)) as typeof setTimeout;

    let changes = 0;
    const controller = createTranscriptHoldController(document);
    const unsubscribe = controller.subscribe(() => {
      changes += 1;
    });
    handlers.get('pointerdown')?.({ pointerType: 'mouse' });
    await new Promise(resolve => originalSetTimeout(resolve, 0));
    unsubscribe();

    expect(changes).toBe(2);
  });

  test('publishes ordinary and settled releases and clears a blurred gesture', async () => {
    const document = {
      getSelection: () => null,
      addEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
      addWindowEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
    };
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...arguments_: unknown[]) =>
      delay === MAX_TRANSCRIPT_HOLD_MS || delay === TOUCH_SELECTION_RELEASE_SETTLE_MS
        ? originalSetTimeout(callback, 0, ...arguments_)
        : originalSetTimeout(callback, delay, ...arguments_)) as typeof setTimeout;

    let changes = 0;
    const controller = createTranscriptHoldController(document);
    const unsubscribe = controller.subscribe(() => {
      changes += 1;
    });
    handlers.get('pointerdown')?.({ pointerType: 'mouse' });
    handlers.get('pointerup')?.({ pointerType: 'mouse' });
    handlers.get('pointerdown')?.({ pointerType: 'touch' });
    handlers.get('pointerup')?.({ pointerType: 'touch' });
    handlers.get('pointercancel')?.({ pointerType: 'touch' });
    await new Promise(resolve => originalSetTimeout(resolve, 0));
    handlers.get('pointerdown')?.({ pointerType: 'mouse' });
    handlers.get('blur')?.({});
    unsubscribe();

    expect(changes).toBe(6);
  });

  test('adapts browser event targets at the production composition seam', () => {
    const browserHandlers = new Map<string, (event: Event) => void>();
    const browserPort = createBrowserTranscriptHoldPort(
      {
        getSelection: () => null,
        addEventListener: (name: string, handler: (event: Event) => void) => browserHandlers.set(name, handler),
      } as unknown as Document,
      {
        addEventListener: (name: string, handler: (event: Event) => void) => browserHandlers.set(name, handler),
      } as unknown as Window,
    );
    const controller = createTranscriptHoldController(browserPort);
    const unsubscribe = controller.subscribe(() => undefined);
    browserHandlers.get('pointerdown')?.({ pointerType: 'mouse' } as PointerEvent);
    browserHandlers.get('blur')?.(new Event('blur'));
    unsubscribe();

    expect(browserPort?.getSelection()).toBeNull();
  });
});
