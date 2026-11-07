/**
 * VIEWPORT DETAILS — what this device's browser says about its own screen, and what the app made of it.
 *
 * The bottom of the app on an iPhone has been "fixed" three times from a desktop browser that cannot
 * reproduce the phone: Chromium simulates a home-indicator inset, but not iOS's installed-app viewport.
 * This turns one reading of the real device into rows a person can screenshot and a short list of
 * plain findings, so the next report carries numbers instead of "still very far".
 *
 * Pure: the browser reading is `ViewportReading`, gathered by the Settings panel
 * (`features/settings/viewport-details.tsx`).
 */

/** A box on screen, in CSS pixels from the top-left of the layout viewport. */
export interface ViewportRect {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

export type DisplayMode = 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser';

export interface ViewportReading {
  readonly displayMode: DisplayMode;
  /** iOS's own `navigator.standalone`; null where the browser has no such field. */
  readonly iosStandalone: boolean | null;
  readonly screen: { readonly width: number; readonly height: number };
  readonly innerWidth: number;
  readonly innerHeight: number;
  /** `document.documentElement.clientHeight`. */
  readonly clientHeight: number;
  readonly visual: { readonly height: number; readonly offsetTop: number } | null;
  /** 100vh / 100dvh / 100svh / 100lvh, each measured in px. */
  readonly units: { readonly vh: number; readonly dvh: number; readonly svh: number; readonly lvh: number };
  /** The platform's safe-area insets, as the stylesheet read them (`--inset-*`). */
  readonly insets: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
  /** What the bottom of the screen pays the home indicator right now (`--safe-bottom`). */
  readonly safeBottom: number;
  readonly keyboardOpen: boolean;
  /** `--app-h` as written by the keyboard frame; null at rest. */
  readonly appHeight: string | null;
  readonly shell: ViewportRect | null;
  /** The bar the screen ends in (`[data-safe-bottom]`), when one is on screen. */
  readonly bottomBar: ViewportRect | null;
  readonly composer: ViewportRect | null;
  readonly jumpPill: ViewportRect | null;
}

export interface ViewportRow {
  readonly label: string;
  readonly value: string;
}

/** One finding: `ok` is a number that is where it should be, `off` one that is not. */
export interface ViewportFinding {
  readonly tone: 'ok' | 'off';
  readonly text: string;
}

const px = (value: number): string => `${Math.round(value * 10) / 10}px`;
const rect = (box: ViewportRect | null): string =>
  box === null ? 'not on this screen' : `top ${px(box.top)} · bottom ${px(box.bottom)} · height ${px(box.height)}`;

/** The screen's height the way the window is turned: iOS keeps `screen` in portrait whichever way it is held. */
export const screenHeightNow = (reading: ViewportReading): number => {
  const long = Math.max(reading.screen.width, reading.screen.height);
  const short = Math.min(reading.screen.width, reading.screen.height);
  return reading.innerWidth > reading.innerHeight ? short : long;
};

/** An installed app owns the whole screen; a browser tab owns what its toolbars leave. */
const installed = (reading: ViewportReading): boolean =>
  reading.displayMode !== 'browser' || reading.iosStandalone === true;

/** Where the app's ground can end: the screen's edge when installed, the window's otherwise. */
export const bottomEdge = (reading: ViewportReading): number =>
  installed(reading) ? screenHeightNow(reading) : reading.innerHeight;

/** Every number, in the order a person comparing two screenshots reads them. */
export function viewportRows(reading: ViewportReading): readonly ViewportRow[] {
  const visual = reading.visual;
  return [
    {
      label: 'Display mode',
      value:
        reading.iosStandalone === null
          ? reading.displayMode
          : `${reading.displayMode} · iOS standalone ${reading.iosStandalone ? 'yes' : 'no'}`,
    },
    { label: 'Screen', value: `${px(reading.screen.width)} × ${px(reading.screen.height)}` },
    { label: 'innerWidth × innerHeight', value: `${px(reading.innerWidth)} × ${px(reading.innerHeight)}` },
    { label: 'documentElement.clientHeight', value: px(reading.clientHeight) },
    {
      label: 'visualViewport',
      value: visual === null ? 'not available' : `height ${px(visual.height)} · offsetTop ${px(visual.offsetTop)}`,
    },
    {
      label: '100vh / dvh / svh / lvh',
      value: [reading.units.vh, reading.units.dvh, reading.units.svh, reading.units.lvh].map(px).join(' / '),
    },
    {
      label: 'Safe area top / right / bottom / left',
      value: [reading.insets.top, reading.insets.right, reading.insets.bottom, reading.insets.left].map(px).join(' / '),
    },
    { label: '--safe-bottom', value: px(reading.safeBottom) },
    { label: 'Keyboard', value: reading.keyboardOpen ? 'open' : 'closed' },
    { label: '--app-h', value: reading.appHeight ?? 'unset (the shell is 100dvh)' },
    { label: 'Shell', value: rect(reading.shell) },
    { label: 'Bottom bar', value: rect(reading.bottomBar) },
    { label: 'Composer', value: rect(reading.composer) },
    { label: 'Jump to latest', value: rect(reading.jumpPill) },
  ];
}

/** Off by more than this many CSS pixels is worth a sentence; rounding and hairlines are not. */
const SLACK = 1;
/** The jump pill sits this far above the composer's top edge: close enough to read as its, never touching. */
export const PILL_GAP = { min: 8, max: 16 } as const;

/** What the numbers mean, in sentences, for the cases that have gone wrong on a real phone before. */
export function viewportFindings(reading: ViewportReading): readonly ViewportFinding[] {
  const findings: ViewportFinding[] = [];
  const edge = bottomEdge(reading);
  if (installed(reading) && !reading.keyboardOpen) {
    const short = screenHeightNow(reading) - reading.innerHeight;
    findings.push(
      short > SLACK
        ? {
            tone: 'off',
            text: `The installed app's viewport is ${px(short)} shorter than the screen (the iOS 26 short-viewport bug).`,
          }
        : { tone: 'ok', text: 'The installed app has the whole screen.' },
    );
  }
  if (reading.shell !== null && !reading.keyboardOpen) {
    const band = edge - reading.shell.bottom;
    findings.push(
      band > SLACK
        ? { tone: 'off', text: `The app stops ${px(band)} above the bottom of the screen.` }
        : { tone: 'ok', text: 'The app reaches the bottom of the screen.' },
    );
  }
  if (reading.composer !== null && reading.shell !== null) {
    // With the keyboard up the composer's floor is the visible box, which the shell is sized to.
    const floor = reading.keyboardOpen ? reading.shell.bottom : edge;
    const under = floor - reading.composer.bottom;
    const allowed = Math.max(reading.safeBottom, 8);
    findings.push(
      under > allowed + SLACK
        ? {
            tone: 'off',
            text: `The composer ends ${px(under)} above the bottom; at most ${px(allowed)} belongs there.`,
          }
        : { tone: 'ok', text: `The composer ends ${px(under)} above the bottom.` },
    );
  }
  if (reading.composer !== null && reading.jumpPill !== null) {
    const gap = reading.composer.top - reading.jumpPill.bottom;
    findings.push(
      gap < PILL_GAP.min - SLACK || gap > PILL_GAP.max + SLACK
        ? {
            tone: 'off',
            text: `Jump to latest sits ${px(gap)} above the composer; it belongs ${PILL_GAP.min}–${PILL_GAP.max}px above it.`,
          }
        : { tone: 'ok', text: `Jump to latest sits ${px(gap)} above the composer.` },
    );
  }
  return findings;
}
