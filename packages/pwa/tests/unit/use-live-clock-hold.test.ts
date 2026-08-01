import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_TRANSCRIPT_HOLD_MS, subscribeTranscriptHold } from '../../src/hooks/use-live-clock.ts';

type Handler = (event: { readonly pointerType?: string }) => void;
const handlers = new Map<string, Handler>();
const globals = globalThis as typeof globalThis & { document?: unknown; window?: unknown };
const originalDocument = globals.document;
const originalWindow = globals.window;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globals.document = originalDocument;
  globals.window = originalWindow;
  globalThis.setTimeout = originalSetTimeout;
  handlers.clear();
});

describe('the transcript hold controller', () => {
  test('releases a pointer gesture at its hard cap', async () => {
    globals.document = {
      getSelection: () => null,
      addEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
    } as unknown as Document;
    globals.window = {
      addEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
    } as unknown as Window & typeof globalThis;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...arguments_: unknown[]) =>
      delay === MAX_TRANSCRIPT_HOLD_MS
        ? originalSetTimeout(callback, 0, ...arguments_)
        : originalSetTimeout(callback, delay, ...arguments_)) as typeof setTimeout;

    let changes = 0;
    const unsubscribe = subscribeTranscriptHold(() => {
      changes += 1;
    });
    handlers.get('pointerdown')?.({ pointerType: 'mouse' });
    await new Promise(resolve => originalSetTimeout(resolve, 0));
    unsubscribe();

    expect(changes).toBe(2);
  });
});
