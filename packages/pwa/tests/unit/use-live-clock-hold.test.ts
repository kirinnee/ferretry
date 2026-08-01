import { afterEach, describe, expect, test } from 'bun:test';
import { createTranscriptHoldController, MAX_TRANSCRIPT_HOLD_MS } from '../../src/hooks/use-live-clock.ts';

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
});
