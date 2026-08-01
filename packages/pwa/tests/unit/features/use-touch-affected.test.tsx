import { afterEach, describe, expect, it } from 'bun:test';
import {
  readTouchAffected,
  serverTouchAffected,
  subscribeToTouchAffected,
  touchAffectedFrom,
  useTouchAffected,
  type MediaQueryListLike,
  type TouchModalitySignals,
} from '../../../src/features/learning/use-touch-affected.ts';
import { render } from '../../support/react.ts';

const DESKTOP: TouchModalitySignals = {
  finePrimary: true,
  coarsePrimary: false,
  hoverPrimary: true,
  noHoverPrimary: false,
  anyCoarse: false,
};

const ambient = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
const stubMatchMedia = (value: unknown): void => {
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, writable: true, value });
};
afterEach(() => {
  if (ambient) Object.defineProperty(globalThis, 'matchMedia', ambient);
  else Reflect.deleteProperty(globalThis, 'matchMedia');
});

/** A matcher answering every query with one fixed verdict. */
const uniform = (matches: boolean, listenable = true) => {
  const attached = new Map<string, Set<() => void>>();
  const matchMedia = (query: string): MediaQueryListLike => ({
    matches,
    ...(listenable
      ? {
          addEventListener: (_type: 'change', listener: () => void) => {
            const set = attached.get(query) ?? new Set();
            set.add(listener);
            attached.set(query, set);
          },
          removeEventListener: (_type: 'change', listener: () => void) => {
            attached.get(query)?.delete(listener);
          },
        }
      : {}),
  });
  const listeners = () => [...attached.values()].reduce((total, set) => total + set.size, 0);
  return { matchMedia, listeners };
};

/** The desktop answer: fine + hover true, every coarse/no-hover query false. */
const desktopMatchMedia = (query: string): MediaQueryListLike => ({
  matches: query === '(pointer: fine)' || query === '(hover: hover)',
});

function Probe() {
  return <span>{useTouchAffected() ? 'touch' : 'pointer'}</span>;
}

describe('touchAffectedFrom', () => {
  it('clears a device only when every signal positively says fine-and-hovering', () => {
    expect(touchAffectedFrom(DESKTOP)).toBe(false);
    // Each signal on its own is enough to keep the conservative verdict.
    expect(touchAffectedFrom({ ...DESKTOP, finePrimary: false })).toBe(true);
    expect(touchAffectedFrom({ ...DESKTOP, coarsePrimary: true })).toBe(true);
    expect(touchAffectedFrom({ ...DESKTOP, hoverPrimary: false })).toBe(true);
    expect(touchAffectedFrom({ ...DESKTOP, noHoverPrimary: true })).toBe(true);
    // A hybrid laptop with a touchscreen: fine primary, coarse available.
    expect(touchAffectedFrom({ ...DESKTOP, anyCoarse: true })).toBe(true);
  });

  it('treats an unanswered signal as unknown rather than as a no', () => {
    for (const key of Object.keys(DESKTOP) as (keyof TouchModalitySignals)[]) {
      expect(touchAffectedFrom({ ...DESKTOP, [key]: null })).toBe(true);
    }
  });
});

describe('readTouchAffected', () => {
  it('reports touch-affected when the environment offers no matchMedia at all', () => {
    stubMatchMedia(undefined);
    expect(readTouchAffected()).toBe(true);
  });

  it('reports touch-affected when a query throws instead of answering', () => {
    stubMatchMedia(() => {
      throw new Error('unsupported query');
    });
    expect(readTouchAffected()).toBe(true);
  });

  it('clears a mouse-and-hover desktop and rejects a coarse-pointer phone', () => {
    stubMatchMedia(desktopMatchMedia);
    expect(readTouchAffected()).toBe(false);
    stubMatchMedia(uniform(true).matchMedia);
    expect(readTouchAffected()).toBe(true);
  });
});

describe('subscribeToTouchAffected', () => {
  it('does nothing, reversibly, when there is no matchMedia to listen to', () => {
    stubMatchMedia(undefined);
    expect(() => subscribeToTouchAffected(() => undefined)()).not.toThrow();
  });

  it('attaches to every query and detaches all of them on cleanup', () => {
    const media = uniform(false);
    stubMatchMedia(media.matchMedia);
    const unsubscribe = subscribeToTouchAffected(() => undefined);
    expect(media.listeners()).toBe(5);
    unsubscribe();
    expect(media.listeners()).toBe(0);
  });

  it('skips a matcher that cannot report changes rather than failing', () => {
    stubMatchMedia(uniform(false, false).matchMedia);
    expect(() => subscribeToTouchAffected(() => undefined)()).not.toThrow();
  });

  it('tolerates a matcher that can attach a listener but not remove one', () => {
    stubMatchMedia((): MediaQueryListLike => ({ matches: false, addEventListener: () => undefined }));
    expect(() => subscribeToTouchAffected(() => undefined)()).not.toThrow();
  });
});

describe('useTouchAffected', () => {
  it('assumes touch before anything has been measured', () => {
    expect(serverTouchAffected()).toBe(true);
  });

  it('gives a component the live verdict for its device', () => {
    stubMatchMedia(desktopMatchMedia);
    const desktop = render(<Probe />);
    expect(JSON.stringify(desktop.toJSON())).toContain('pointer');

    stubMatchMedia(uniform(true).matchMedia);
    const phone = render(<Probe />);
    expect(JSON.stringify(phone.toJSON())).toContain('touch');
  });
});
