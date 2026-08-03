import { describe, expect, it } from 'bun:test';
import {
  attemptPortraitLock,
  installPortraitLock,
  isPhoneLandscape,
  syncPortraitGate,
} from '../../src/lib/orientation-lock.ts';
import { must } from '../support/dom.ts';

interface FakeView {
  readonly coarse?: boolean;
  readonly screen?: { readonly width?: number; readonly height?: number; readonly orientation?: { type?: string } };
  /** What `(orientation: landscape)` answers — the keyboard CAN flip this one. */
  readonly mediaLandscape?: boolean;
  readonly noMatchMedia?: boolean;
  /** Viewport numbers the old width-vs-height inference read; kept so the keyboard case stays literal. */
  readonly innerWidth?: number;
  readonly innerHeight?: number;
}

const view = (fake: FakeView): Window =>
  ({
    innerWidth: fake.innerWidth ?? 0,
    innerHeight: fake.innerHeight ?? 0,
    screen: fake.screen,
    matchMedia:
      fake.noMatchMedia === true
        ? undefined
        : (query: string) => ({
            matches: query.includes('coarse') ? (fake.coarse ?? false) : (fake.mediaLandscape ?? false),
          }),
  }) as unknown as Window;

const PHONE_UPRIGHT = { width: 360, height: 800 };
const PHONE_SIDEWAYS = { width: 800, height: 360 };

/** The reported failure: Android, pairing field focused, viewport collapsed to 360x345. */
const keyboardOpenPhone = view({
  coarse: true,
  innerWidth: 360,
  innerHeight: 345,
  screen: { ...PHONE_UPRIGHT, orientation: { type: 'portrait-primary' } },
  mediaLandscape: true,
});

const sidewaysPhone = view({
  coarse: true,
  innerWidth: 800,
  innerHeight: 360,
  screen: { ...PHONE_SIDEWAYS, orientation: { type: 'landscape-primary' } },
});

const uprightPhone = view({
  coarse: true,
  innerWidth: 360,
  innerHeight: 800,
  screen: { ...PHONE_UPRIGHT, orientation: { type: 'portrait-primary' } },
});

describe('portrait orientation policy', () => {
  it('accepts a supported lock and safely refuses absent or rejected APIs', async () => {
    const calls: string[] = [];
    const orientation = { lock: async (value: string) => calls.push(value) } as unknown as ScreenOrientation;
    expect(await attemptPortraitLock({ orientation })).toBe(true);
    expect(calls).toEqual(['portrait']);
    expect(await attemptPortraitLock({ orientation: {} as ScreenOrientation })).toBe(false);
    expect(
      await attemptPortraitLock({
        orientation: { lock: async () => Promise.reject(new Error('refused')) } as unknown as ScreenOrientation,
      }),
    ).toBe(false);
  });
});

describe('isPhoneLandscape', () => {
  it('does not gate an upright phone whose viewport a software keyboard collapsed', () => {
    // 360x345 is wider than it is tall, and the media query agrees with the collapsed
    // viewport — only screen.orientation still knows the phone never moved.
    expect(isPhoneLandscape(keyboardOpenPhone)).toBe(false);
    expect(isPhoneLandscape(uprightPhone)).toBe(false);
  });

  it('gates a phone the platform itself reports as landscape', () => {
    expect(isPhoneLandscape(sidewaysPhone)).toBe(true);
  });

  it('reads the orientation media query only when screen.orientation says nothing', () => {
    const silent = (mediaLandscape: boolean, type?: string): Window =>
      view({
        coarse: true,
        screen: { ...PHONE_SIDEWAYS, orientation: type === undefined ? undefined : { type } },
        mediaLandscape,
      });
    expect(isPhoneLandscape(silent(true))).toBe(true);
    expect(isPhoneLandscape(silent(false))).toBe(false);
    expect(isPhoneLandscape(silent(true, ''))).toBe(true);
    expect(isPhoneLandscape(silent(false, ''))).toBe(false);
  });

  it('leaves every non-phone landscape alone', () => {
    const desktop = view({ screen: { width: 1440, height: 900, orientation: { type: 'landscape-primary' } } });
    const tablet = view({
      coarse: true,
      screen: { width: 1112, height: 834, orientation: { type: 'landscape-primary' } },
    });
    expect(isPhoneLandscape(desktop)).toBe(false);
    expect(isPhoneLandscape(tablet)).toBe(false);
  });

  it('refuses to gate on evidence it does not have', () => {
    const noScreen = view({ coarse: true, mediaLandscape: true });
    const noDimensions = view({ coarse: true, screen: { orientation: { type: 'landscape-primary' } } });
    const zeroDimensions = view({
      coarse: true,
      screen: { width: 0, height: 0, orientation: { type: 'landscape-primary' } },
    });
    const unmeasurable = view({
      coarse: true,
      screen: { width: Number.NaN, height: 800, orientation: { type: 'landscape-primary' } },
    });
    const noMatchMedia = view({
      noMatchMedia: true,
      screen: { ...PHONE_SIDEWAYS, orientation: { type: 'landscape-primary' } },
    });
    for (const blind of [noScreen, noDimensions, zeroDimensions, unmeasurable, noMatchMedia]) {
      expect(isPhoneLandscape(blind)).toBe(false);
    }
  });
});

const GATE_SELECTOR = '#fy-portrait-gate';

describe('syncPortraitGate', () => {
  it('mounts one body-level layer for a sideways phone and removes it on rotation', () => {
    syncPortraitGate(document, sidewaysPhone);
    syncPortraitGate(document, sidewaysPhone);
    expect(document.querySelectorAll(GATE_SELECTOR).length).toBe(1);

    const gate = must(document.querySelector(GATE_SELECTOR), 'the portrait gate');
    // A full-bleed layer has to be a child of body: nested inside the app it would be
    // clipped by, and stack against, the very screen it is meant to cover.
    expect(gate.parentElement).toBe(document.body);
    expect(gate.getAttribute('role')).toBe('alertdialog');
    expect(gate.getAttribute('aria-label')).toBe('Rotate your device to portrait');
    expect(gate.textContent).toContain('Turn your phone upright');

    syncPortraitGate(document, uprightPhone);
    expect(document.querySelector(GATE_SELECTOR)).toBeNull();
  });

  it('stays out of the way while someone types on an upright phone', () => {
    syncPortraitGate(document, keyboardOpenPhone);
    expect(document.querySelector(GATE_SELECTOR)).toBeNull();
  });

  it('is dressed as a full-bleed layer by the stylesheet the app actually ships', async () => {
    // The gate used to mount under an id the stylesheet did not target, so it arrived
    // unstyled: block text at the end of the body, interleaved with the page underneath
    // instead of covering it. Assert against the real sheet, not against an idea of it.
    const source = await Bun.file(new URL('../../src/styles/index.css', import.meta.url)).text();
    const sheet = document.createElement('style');
    // `@import` would send happy-dom looking for a file over the network; the token layer
    // it pulls in is not what this test is about.
    sheet.textContent = source.replaceAll(/^@import.*$/gm, '');
    document.head.appendChild(sheet);
    syncPortraitGate(document, sidewaysPhone);

    try {
      const gate = must(document.querySelector(GATE_SELECTOR), 'the portrait gate');
      const style = getComputedStyle(gate);
      expect(style.position).toBe('fixed');
      // happy-dom keeps `inset` as the shorthand rather than expanding the four edges.
      expect(['0', '0px']).toContain(style.getPropertyValue('inset'));
      expect(Number(style.zIndex)).toBeGreaterThan(0);
      expect(style.display).toBe('flex');
    } finally {
      sheet.remove();
      syncPortraitGate(document, uprightPhone);
    }
  });

  it('takes the gate down when the keyboard opens on a phone that was sideways', () => {
    syncPortraitGate(document, sidewaysPhone);
    expect(document.querySelectorAll(GATE_SELECTOR).length).toBe(1);
    syncPortraitGate(document, keyboardOpenPhone);
    expect(document.querySelector(GATE_SELECTOR)).toBeNull();
  });
});

describe('installPortraitLock', () => {
  it('syncs immediately, tracks orientation changes, and retries after the first gesture when needed', async () => {
    const originalScreen = Object.getOwnPropertyDescriptor(globalThis, 'screen');
    Object.defineProperty(globalThis, 'screen', { configurable: true, value: { orientation: {} } });
    const listeners = new Map<string, () => void>();
    const live = {
      ...uprightPhone,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    } as unknown as Window;

    try {
      installPortraitLock(live, document);
      await Promise.resolve();
      listeners.get('pointerdown')?.();
      await Promise.resolve();

      expect([...listeners.keys()].sort()).toEqual(['orientationchange', 'pointerdown', 'resize']);
      expect(document.querySelector(GATE_SELECTOR)).toBeNull();

      // A resize is what the keyboard fires; it must not conjure the gate on an upright phone.
      listeners.get('resize')?.();
      expect(document.querySelector(GATE_SELECTOR)).toBeNull();
    } finally {
      if (originalScreen) Object.defineProperty(globalThis, 'screen', originalScreen);
      else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'screen');
    }
  });
});
