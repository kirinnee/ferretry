import { describe, expect, it } from 'bun:test';
import '../support/dom.ts';
import {
  browserPresenceEnvironment,
  PRESENCE_OPENING_MS,
  PRESENCE_WINDOW_MS,
  type PresenceEnvironment,
  PresenceTracker,
} from '../../src/lib/presence.ts';

const page = (start = 1_000) => {
  let now = start;
  let visible = true;
  let listener: (() => void) | undefined;
  let removed = false;
  const environment: PresenceEnvironment = {
    now: () => now,
    visible: () => visible,
    onInteraction: next => {
      listener = next;
      return () => {
        removed = true;
      };
    },
  };
  return {
    environment,
    advance: (ms: number) => {
      now += ms;
    },
    hide: () => {
      visible = false;
    },
    touch: () => listener?.(),
    removed: () => removed,
  };
};

describe('PresenceTracker', () => {
  it('counts a page that was just opened as attended, before anybody touches it', () => {
    const fake = page();
    const tracker = new PresenceTracker(fake.environment);
    expect(tracker.present()).toBe(true);
    fake.advance(PRESENCE_OPENING_MS - 1);
    expect(tracker.present()).toBe(true);
  });

  it('stops counting an untouched page once the opening minute is over', () => {
    const fake = page();
    const tracker = new PresenceTracker(fake.environment);
    fake.advance(PRESENCE_OPENING_MS);
    expect(tracker.present()).toBe(false);
  });

  it('counts an interaction for five minutes and no longer', () => {
    const fake = page();
    const tracker = new PresenceTracker(fake.environment);
    fake.advance(PRESENCE_OPENING_MS * 10);
    fake.touch();
    fake.advance(PRESENCE_WINDOW_MS - 1);
    expect(tracker.present()).toBe(true);
    fake.advance(1);
    expect(tracker.present()).toBe(false);
  });

  it('never counts a hidden page, however recently it was touched', () => {
    const fake = page();
    const tracker = new PresenceTracker(fake.environment);
    fake.touch();
    fake.hide();
    expect(tracker.present()).toBe(false);
  });

  it('removes its listener when stopped', () => {
    const fake = page();
    const tracker = new PresenceTracker(fake.environment);
    tracker.stop();
    expect(fake.removed()).toBe(true);
  });
});

describe('browserPresenceEnvironment', () => {
  it('hears a key press anywhere in the page until the listener is removed', () => {
    const environment = browserPresenceEnvironment();
    let heard = 0;
    const stop = environment.onInteraction(() => {
      heard += 1;
    });
    window.dispatchEvent(new KeyboardEvent('keydown'));
    stop();
    window.dispatchEvent(new KeyboardEvent('keydown'));
    expect(heard).toBe(1);
    expect(environment.visible()).toBe(document.visibilityState !== 'hidden');
    expect(Math.abs(environment.now() - Date.now())).toBeLessThan(1_000);
  });

  it('listens to nothing where there is no window', () => {
    const saved = globalThis.window;
    // @ts-expect-error -- a worker or a test runner without a page has no window
    delete globalThis.window;
    try {
      const stop = browserPresenceEnvironment().onInteraction(() => undefined);
      expect(stop()).toBeUndefined();
    } finally {
      globalThis.window = saved;
    }
  });
});
