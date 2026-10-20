/**
 * THE BOTTOM SAFE-AREA INSET HAS ONE OWNER, MEASURED IN A REAL BROWSER.
 *
 * On a home-indicator iPhone the app showed a band of dead space under the composer and under the tab
 * bar: `.kt-shell` paid `env(safe-area-inset-bottom)` and then the composer / the tab bar paid it AGAIN
 * inside the shell, so the gap was twice the inset. A screenshot shows that badly — the band is just
 * background — so every claim here is a number.
 *
 * Chromium simulates the inset with `Emulation.setSafeAreaInsetsOverride`; the 34px bottom and 59px top
 * are an iPhone 15 / 16 Pro's. It is the layout half of the iOS standalone case: WebKit itself is not
 * installed on the runners, and the geometry is the shell's CSS, not an engine quirk.
 *
 * Every check announces itself and is counted: a check that stops being reached reads exactly like one
 * that passed, so the run owes `SAFE_AREA_GEOMETRY_CHECKS`.
 */

import { join } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';

/** An iPhone 15 / 16 Pro in portrait. */
const PORTRAIT = { width: 393, height: 852, insets: { top: 59, bottom: 34, left: 0, right: 0 } } as const;
/** The same phone on its side: the home indicator is shorter and the notch moves to a side. */
const LANDSCAPE = { width: 852, height: 393, insets: { top: 0, bottom: 21, left: 59, right: 59 } } as const;
/** A software keyboard's visual viewport, an iPhone-plausible ~420px of the 852. */
const KEYBOARD_VISUAL_HEIGHT = 430;
/** The composer's own bottom padding (0.5rem), the only thing allowed under it besides the inset. */
const COMPOSER_PAD = 8;
const EPSILON = 1;

export const SAFE_AREA_GEOMETRY_CHECKS = 3 + 3 + 2 + 2 + 2;

export interface SafeAreaRun {
  readonly browser: Browser;
  readonly rootUrl: string;
  readonly scheme: 'light' | 'dark';
  readonly fail: (message: string) => never;
  /** The init script that makes `window.__harnessKeyboard(height)` move only the visual viewport. */
  readonly keyboardShim: string;
  /** Present: also capture the before/after evidence frames into this directory. */
  readonly captureDir?: string;
}

const IPHONE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

interface Measure {
  readonly innerHeight: number;
  readonly safeBottom: number;
  readonly shellBottom: number;
  readonly shellPaddingBottom: number;
  readonly inputBottom: number | null;
  readonly inputPaddingBottom: number | null;
  readonly tabbarBottom: number | null;
  readonly tabItemsBottom: number | null;
}

/** Measured once layout has settled: reduced motion still runs a 1ms transition on every element. */
const measure = (page: Page): Promise<Measure> =>
  page.evaluate(async () => {
    // An infinite busy mark (a spinner's pulse) never finishes, and is not layout.
    const finite = document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY);
    await Promise.all(finite.map(animation => animation.finished.catch(() => undefined)));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const shell = document.querySelector('.kt-shell');
    if (!(shell instanceof HTMLElement)) throw new Error('no .kt-shell on the page');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);width:1px';
    document.body.append(probe);
    const safeBottom = probe.getBoundingClientRect().height;
    probe.remove();
    const bottomOf = (selector: string): number | null =>
      document.querySelector(selector)?.getBoundingClientRect().bottom ?? null;
    const padOf = (selector: string): number | null => {
      const element = document.querySelector(selector);
      return element === null ? null : Number.parseFloat(getComputedStyle(element).paddingBottom);
    };
    const items = [...document.querySelectorAll('.kt-tabbar__item')];
    return {
      innerHeight: window.innerHeight,
      safeBottom,
      shellBottom: shell.getBoundingClientRect().bottom,
      shellPaddingBottom: Number.parseFloat(getComputedStyle(shell).paddingBottom),
      inputBottom: bottomOf('.fy-chat-input'),
      inputPaddingBottom: padOf('.fy-chat-input'),
      tabbarBottom: bottomOf('.kt-tabbar'),
      tabItemsBottom: items.length === 0 ? null : Math.max(...items.map(item => item.getBoundingClientRect().bottom)),
    };
  });

export async function runSafeAreaGeometry(run: SafeAreaRun): Promise<number> {
  const { browser, rootUrl, scheme } = run;
  const fail: (message: string) => never = run.fail;
  let checks = 0;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON;
  const pass = (where: string, what: string): void => {
    checks += 1;
    process.stdout.write(`   safe area @ ${where}: ${what}\n`);
  };

  const open = async (
    screen: {
      readonly width: number;
      readonly height: number;
      readonly insets: Readonly<Record<'top' | 'bottom' | 'left' | 'right', number>>;
    },
    query: string,
    work: (page: Page, cdp: CDPSession) => Promise<void>,
  ): Promise<void> => {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: screen.width, height: screen.height },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: IPHONE_USER_AGENT,
      colorScheme: scheme,
      reducedMotion: 'reduce',
    });
    try {
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== new URL(rootUrl).origin) await route.abort();
        else await route.continue();
      });
      await context.addInitScript(run.keyboardShim);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: screen.insets });
      await page.goto(`${rootUrl}${query}`);
      if (query.startsWith('#')) await page.reload();
      await page.locator('.kt-shell').first().waitFor({ state: 'visible' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await work(page, cdp);
    } finally {
      await context.close();
    }
  };

  const frame = async (page: Page, name: string): Promise<void> => {
    if (run.captureDir !== undefined)
      await page.screenshot({ path: join(run.captureDir, `safe-area-${name}-${scheme}.png`) });
  };

  const insetWhere = (screen: typeof PORTRAIT | typeof LANDSCAPE): string => `${screen.width}x${screen.height}`;

  // 1. The chat: the shell reserves the inset once; the composer adds only its own padding.
  await open(PORTRAIT, '#session-workspace', async page => {
    await page.locator('.fy-chat-input').waitFor({ state: 'visible' });
    const at = await measure(page);
    const where = `${insetWhere(PORTRAIT)} chat`;
    if (!near(at.safeBottom, PORTRAIT.insets.bottom))
      fail(
        `the harness did not simulate the inset: env(safe-area-inset-bottom) is ${at.safeBottom}px, wanted ${PORTRAIT.insets.bottom}px`,
      );
    if (!near(at.shellPaddingBottom, at.safeBottom))
      fail(`${where}: the shell pays ${at.shellPaddingBottom}px, not the one inset (${at.safeBottom}px)`);
    pass(where, `shell reserves the inset once (${at.shellPaddingBottom}px)`);
    if (at.inputPaddingBottom !== COMPOSER_PAD)
      fail(
        `${where}: the composer pays ${at.inputPaddingBottom}px under itself, wanted its own ${COMPOSER_PAD}px and no second inset`,
      );
    pass(where, `composer adds only its own ${COMPOSER_PAD}px`);
    const gap = at.innerHeight - (at.inputBottom ?? Number.NaN);
    if (!near(gap, at.safeBottom))
      fail(
        `${where}: the composer's box ends ${gap}px above the screen edge — one inset is ${at.safeBottom}px, so a band of ${gap - at.safeBottom}px is dead space`,
      );
    pass(where, `composer box ends ${gap}px above the edge (= the inset)`);
    await frame(page, 'chat');
  });

  // 2. The tab bar: its surface reaches the edge, its buttons clear the indicator by exactly one inset.
  for (const destination of ['settings', 'sessions'] as const)
    await open(PORTRAIT, `?app-chrome=${destination}`, async page => {
      await page.locator('.kt-tabbar').waitFor({ state: 'visible' });
      const at = await measure(page);
      const where = `${insetWhere(PORTRAIT)} ${destination}`;
      if (!near(at.tabbarBottom ?? Number.NaN, at.innerHeight))
        fail(
          `${where}: the tab bar's surface ends at ${at.tabbarBottom}px, ${at.innerHeight - (at.tabbarBottom ?? 0)}px short of the screen edge`,
        );
      pass(where, 'tab bar surface reaches the screen edge');
      const clear = at.innerHeight - (at.tabItemsBottom ?? Number.NaN);
      if (!near(clear, at.safeBottom))
        fail(
          `${where}: the tab buttons end ${clear}px above the edge — exactly one inset (${at.safeBottom}px) belongs there`,
        );
      pass(where, `tab buttons clear the indicator by one inset (${clear}px)`);
      if (destination === 'settings') await frame(page, 'settings');
      else await frame(page, 'sessions');
      if (destination === 'settings') {
        // The keyboard hides the tab bar's buttons' need for an inset: nothing may keep reserving one.
        await page.evaluate(
          h => (window as unknown as { __harnessKeyboard: (n: number) => void }).__harnessKeyboard(h),
          KEYBOARD_VISUAL_HEIGHT,
        );
        await page.waitForFunction(() => document.documentElement.dataset.keyboard === 'open');
        const open = await measure(page);
        if (open.shellPaddingBottom !== 0)
          fail(`${where}: with the keyboard up the shell still reserves ${open.shellPaddingBottom}px`);
        pass(where, 'keyboard up: the shell reserves nothing');
      }
    });

  // 3. The keyboard opens and closes over the chat: no inset left above the keys, and it comes back.
  await open(PORTRAIT, '#session-workspace', async page => {
    await page.locator('.fy-chat-input').waitFor({ state: 'visible' });
    const where = `${insetWhere(PORTRAIT)} chat keyboard`;
    const keyboard = (height: number | null): Promise<void> =>
      page.evaluate(
        h => (window as unknown as { __harnessKeyboard: (n: number | null) => void }).__harnessKeyboard(h),
        height,
      );
    await keyboard(KEYBOARD_VISUAL_HEIGHT);
    await page.waitForFunction(() => document.documentElement.dataset.keyboard === 'open');
    const up = await measure(page);
    if (!near(up.shellBottom, KEYBOARD_VISUAL_HEIGHT))
      fail(
        `${where}: the shell ends at ${up.shellBottom}px, not at the visible viewport (${KEYBOARD_VISUAL_HEIGHT}px)`,
      );
    const above = up.shellBottom - (up.inputBottom ?? Number.NaN);
    if (!near(above, 0))
      fail(
        `${where}: ${above}px of dead space sits between the composer and the keyboard — the home-indicator inset is still reserved`,
      );
    pass(where, 'composer sits flush on the keyboard');
    await frame(page, 'chat-keyboard');
    await keyboard(null);
    await page.waitForFunction(() => document.documentElement.dataset.keyboard === undefined);
    const closed = await measure(page);
    if (!near(closed.innerHeight - (closed.inputBottom ?? Number.NaN), closed.safeBottom))
      fail(
        `${where}: after the keyboard closed the composer ends ${closed.innerHeight - (closed.inputBottom ?? 0)}px above the edge, wanted ${closed.safeBottom}px`,
      );
    pass(where, 'keyboard closed: the one inset is back and nothing is left over');
  });

  // 4. Rotation: the landscape home indicator is shorter, and the app follows it rather than keeping portrait's.
  for (const destination of ['chat', 'settings'] as const)
    await open(LANDSCAPE, destination === 'chat' ? '#session-workspace' : '?app-chrome=settings', async page => {
      const where = `${insetWhere(LANDSCAPE)} ${destination}`;
      const at = await measure(page);
      const edge = destination === 'chat' ? at.inputBottom : at.tabItemsBottom;
      if (edge === null) {
        // A landscape phone is wider than the drawer breakpoint's tab bar: the sessions column is shown instead.
        if (!near(at.shellPaddingBottom, LANDSCAPE.insets.bottom))
          fail(
            `${where}: the shell pays ${at.shellPaddingBottom}px, landscape's inset is ${LANDSCAPE.insets.bottom}px`,
          );
        pass(where, `no tab bar at this width; shell reserves landscape's ${at.shellPaddingBottom}px`);
        return;
      }
      const gap = at.innerHeight - edge;
      if (!near(gap, LANDSCAPE.insets.bottom))
        fail(
          `${where}: the bottom control ends ${gap}px above the edge, landscape's single inset is ${LANDSCAPE.insets.bottom}px`,
        );
      pass(where, `bottom control clears the indicator by landscape's one inset (${gap}px)`);
      await frame(page, `landscape-${destination}`);
    });

  return checks;
}
