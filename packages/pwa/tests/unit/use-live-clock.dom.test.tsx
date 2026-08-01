import { afterEach, describe, expect, test } from 'bun:test';
import { useLiveClock, MAX_TRANSCRIPT_HOLD_MS } from '../../src/hooks/use-live-clock.ts';
import { interact, mount } from '../support/dom.ts';

const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
});

const ClockProbe = () => <output>{useLiveClock({ intervalMs: 60_000, now: () => 100 })}</output>;

describe('the document transcript hold', () => {
  test('caps a stuck pointer gesture instead of freezing live labels forever', async () => {
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...arguments_: unknown[]) =>
      delay === MAX_TRANSCRIPT_HOLD_MS
        ? originalSetTimeout(callback, 0, ...arguments_)
        : originalSetTimeout(callback, delay, ...arguments_)) as typeof setTimeout;

    const view = await mount(<ClockProbe />);
    await interact(() =>
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })),
    );
    await new Promise(resolve => originalSetTimeout(resolve, 0));

    expect(view.container.textContent).toBe('100');
    await view.unmount();
  });
});
