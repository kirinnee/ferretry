/**
 * THE BOTTOM OF THE APP ON EVERY KIND OF SCREEN IT SHIPS TO, IN THE ENGINE THAT SCREEN RUNS.
 *
 * `safe-area-geometry.ts` holds one phone to the single-owner rule in Chromium, on CI. This walks the
 * device matrix the iPhone reports came from: iPhone SE, 15 Pro and 15 Pro Max, each as the installed app
 * (the whole screen, notch and home-indicator insets) and as a Safari tab (the window between Safari's
 * bars, no insets), in WebKit; an installed Android app and a desktop window in Chromium. On each, the
 * chat with "Jump to latest" showing and, on a phone, with a keyboard up:
 *
 *   - the app reaches the bottom of its window;
 *   - the composer ends exactly one inset above it on a phone (its own padding absorbed into the inset),
 *     or the inset plus its own padding where the shell pays for several columns;
 *   - "Jump to latest" sits 8–16px above the composer's top edge;
 *   - with a keyboard up, only the composer's own padding sits above the keys.
 *
 * WebKit here is Playwright's Linux WebKit — the iOS engine's layout and CSS, not iOS's browser chrome.
 * It cannot report a home indicator (so the stylesheet's `--inset-*` read stands in for it) and cannot
 * reproduce iOS 26's short installed-app viewport; the frames also carry Settings › This device › About
 * this device's readout so a real iPhone's numbers can be compared against them line by line.
 *
 * Run: `FY_WEBKIT=<playwright webkit pw_run.sh> bun harness/screenshot.ts --viewport-matrix-only [--light]`.
 * Without FY_WEBKIT the WebKit rows are reported as skipped, never as passed.
 */

import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import {
  COMPOSER_PAD,
  detachTranscript,
  type InsetSimulation,
  IPHONE_USER_AGENT,
  keyboard,
  measure,
  openScreen,
  PILL_GAP,
  type Screen,
} from './safe-area-geometry.ts';

type Engine = 'webkit' | 'chromium';

interface MatrixCase {
  readonly name: string;
  readonly engine: Engine;
  readonly screen: Screen;
  /** An installed app: `display-mode: standalone` to script, and iOS's `navigator.standalone`. */
  readonly installed: boolean;
  readonly mobile: boolean;
  readonly userAgent?: string;
}

const NONE = { top: 0, bottom: 0, left: 0, right: 0 } as const;
/** A home-indicator iPhone's portrait insets; the SE has a home button, so only its status bar. */
const NOTCHED = { top: 59, bottom: 34, left: 0, right: 0 } as const;
const ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

/**
 * Screen sizes are the devices' CSS points; a Safari tab's height is what is left between the status bar,
 * the address bar and the toolbar (Playwright's own device descriptors).
 */
const MATRIX: readonly MatrixCase[] = [
  {
    name: 'iphone-se-installed',
    engine: 'webkit',
    screen: { width: 375, height: 667, insets: { ...NONE, top: 20 } },
    installed: true,
    mobile: true,
    userAgent: IPHONE_USER_AGENT,
  },
  {
    name: 'iphone-se-safari',
    engine: 'webkit',
    screen: { width: 375, height: 548, insets: NONE },
    installed: false,
    mobile: true,
    userAgent: IPHONE_USER_AGENT,
  },
  {
    name: 'iphone-15-pro-installed',
    engine: 'webkit',
    screen: { width: 393, height: 852, insets: NOTCHED },
    installed: true,
    mobile: true,
    userAgent: IPHONE_USER_AGENT,
  },
  {
    name: 'iphone-15-pro-safari',
    engine: 'webkit',
    screen: { width: 393, height: 659, insets: NONE },
    installed: false,
    mobile: true,
    userAgent: IPHONE_USER_AGENT,
  },
  {
    name: 'iphone-15-pro-max-installed',
    engine: 'webkit',
    screen: { width: 430, height: 932, insets: NOTCHED },
    installed: true,
    mobile: true,
    userAgent: IPHONE_USER_AGENT,
  },
  {
    name: 'iphone-15-pro-max-safari',
    engine: 'webkit',
    screen: { width: 430, height: 739, insets: NONE },
    installed: false,
    mobile: true,
    userAgent: IPHONE_USER_AGENT,
  },
  {
    name: 'android-installed',
    engine: 'chromium',
    screen: { width: 412, height: 915, insets: NONE },
    installed: true,
    mobile: true,
    userAgent: ANDROID_USER_AGENT,
  },
  {
    name: 'desktop',
    engine: 'chromium',
    screen: { width: 1440, height: 900, insets: NONE },
    installed: false,
    mobile: false,
  },
];

/** Checks one case owes: the app's floor, the composer's floor, the pill, and on a phone the keyboard frame. */
const matrixChecksFor = (entry: MatrixCase): number => (entry.mobile ? 4 : 3);

/** Answers `display-mode: standalone` and sets iOS's flag, the two ways the app can ask whether it is installed. */
const INSTALLED_SCRIPT = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = query => {
    if (/display-mode:\\s*standalone/u.test(query))
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      };
    return real(query);
  };
  Object.defineProperty(window.navigator, 'standalone', { configurable: true, get: () => true });
})();`;

export interface MatrixRun {
  /** The browser for each engine; an absent one is reported as skipped. */
  readonly browsers: Readonly<Partial<Record<Engine, Browser>>>;
  readonly rootUrl: string;
  readonly scheme: 'light' | 'dark';
  readonly fail: (message: string) => never;
  readonly keyboardShim: string;
  readonly captureDir: string;
}

/** A phone's software keyboard leaves this share of the screen visible. */
const KEYBOARD_SHARE = 0.5;
const EPSILON = 1;
/** Narrower than this the bar a screen ends in owns the inset (`DRAWER_MAX`, styles/index.css). */
const PHONE_MAX = 768;

export async function runViewportMatrix(run: MatrixRun): Promise<{ readonly checks: number; readonly owed: number }> {
  const { fail, scheme } = run;
  let checks = 0;
  let owed = 0;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON;
  for (const entry of MATRIX) {
    const browser = run.browsers[entry.engine];
    if (browser === undefined) {
      process.stdout.write(`   ⏭  ${entry.name}: SKIPPED — no ${entry.engine} browser on this machine\n`);
      continue;
    }
    owed += matrixChecksFor(entry);
    const pass = (what: string): void => {
      checks += 1;
      process.stdout.write(`   ${entry.name} (${entry.engine}): ${what}\n`);
    };
    const simulation: InsetSimulation = entry.engine === 'chromium' ? 'cdp' : 'css';
    const shot = (page: Page, frame: string): Promise<Buffer> =>
      page.screenshot({ path: join(run.captureDir, `viewport-${entry.name}-${frame}-${scheme}.png`) });
    await openScreen(
      {
        browser,
        rootUrl: run.rootUrl,
        scheme,
        keyboardShim: run.keyboardShim,
        insetSimulation: simulation,
        isMobile: entry.mobile,
        ...(entry.userAgent === undefined ? {} : { userAgent: entry.userAgent }),
        ...(entry.installed ? { initScript: INSTALLED_SCRIPT } : {}),
      },
      entry.screen,
      '?viewport-overlay#session-workspace',
      async page => {
        await page.locator('.fy-chat-input .fy-composer').waitFor({ state: 'visible' });
        const at = await measure(page);
        if (!near(at.shellBottom, at.innerHeight))
          fail(`${entry.name}: the app stops ${at.innerHeight - at.shellBottom}px above the bottom of its window`);
        pass('the app reaches the bottom of its window');

        const inset = entry.screen.insets.bottom;
        const wanted = entry.screen.width < PHONE_MAX ? Math.max(COMPOSER_PAD, inset) : inset + COMPOSER_PAD;
        const floor = at.innerHeight - (at.composerBottom ?? Number.NaN);
        if (!near(floor, wanted))
          fail(`${entry.name}: the composer ends ${floor}px above the bottom, wanted ${wanted}px (inset ${inset}px)`);
        pass(`the composer ends ${floor}px above the bottom (inset ${inset}px)`);

        await detachTranscript(page);
        const detached = await measure(page);
        const gap = (detached.composerTop ?? Number.NaN) - (detached.pillBottom ?? Number.NaN);
        if (!(gap >= PILL_GAP.min - EPSILON && gap <= PILL_GAP.max + EPSILON))
          fail(
            `${entry.name}: "Jump to latest" sits ${gap}px above the composer, wanted ${PILL_GAP.min}–${PILL_GAP.max}px`,
          );
        pass(`"Jump to latest" sits ${gap}px above the composer`);
        // The readout re-reads on its own tick; let it catch the pill before the frame is taken.
        await page.waitForFunction(() =>
          document.querySelector('[data-viewport-overlay]')?.textContent?.includes('Jump to latest sits'),
        );
        await shot(page, 'chat');

        if (!entry.mobile) return;
        // The readout has been captured with the chat; the keyboard frame is about the composer and the keys.
        await page.locator('[aria-label="Close viewport details"]').click();
        const visible = Math.round(entry.screen.height * KEYBOARD_SHARE);
        await keyboard(page, visible);
        await page.waitForFunction(() => document.documentElement.dataset.keyboard === 'open');
        const up = await measure(page);
        const above = up.shellBottom - (up.composerBottom ?? Number.NaN);
        if (!near(up.shellBottom, visible) || !near(above, COMPOSER_PAD))
          fail(
            `${entry.name}: with the keyboard up the shell ends at ${up.shellBottom}px (wanted ${visible}px) and ` +
              `${above}px sits above the keys (wanted the composer's own ${COMPOSER_PAD}px)`,
          );
        pass(`keyboard up: the composer sits ${above}px above the keys`);
        await shot(page, 'keyboard');
      },
    );
  }
  return { checks, owed };
}
