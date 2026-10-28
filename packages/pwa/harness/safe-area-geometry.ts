/**
 * THE BOTTOM SAFE-AREA INSET HAS ONE OWNER PER SCREEN, MEASURED IN A REAL BROWSER.
 *
 * On a phone the bar a screen ends in — the composer, the tab bar — pays the home-indicator inset once,
 * as `max(its own padding, the inset)`, and the shell pays nothing under it (styles/index.css, THE BOTTOM
 * INSET). Wider than a phone each column pays it for its own content, so its surface runs to the edge. A screenshot shows a wrong answer badly
 * — the band is just background — so every claim here is a number.
 *
 * The inset is simulated two ways. Chromium's `Emulation.setSafeAreaInsetsOverride` makes `env()` itself
 * report it (`cdp`). WebKit has no such switch, so there the stylesheet's one read of each inset
 * (`--inset-top` / `--inset-bottom`) is set instead (`css`) — the same variables every rule below reads,
 * so the geometry is the same; only the platform's report is stood in for. Neither reproduces iOS 26's
 * short installed-app viewport, which is an iOS chrome behaviour: Settings › This device › About this
 * device › Viewport details exists for that.
 *
 * Every check announces itself and is counted: a check that stops being reached reads exactly like one
 * that passed, so the run owes `SAFE_AREA_GEOMETRY_CHECKS`.
 */

import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';

interface Insets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface Screen {
  readonly width: number;
  readonly height: number;
  readonly insets: Insets;
}

/** An iPhone 15 / 16 Pro in portrait. */
const PORTRAIT: Screen = { width: 393, height: 852, insets: { top: 59, bottom: 34, left: 0, right: 0 } };
/** The same phone on its side: the home indicator is shorter and the notch moves to a side. */
const LANDSCAPE: Screen = { width: 852, height: 393, insets: { top: 0, bottom: 21, left: 59, right: 59 } };
/** A software keyboard's visual viewport, an iPhone-plausible ~420px of the 852. */
const KEYBOARD_VISUAL_HEIGHT = 430;
/** The composer dock's own resting padding (0.5rem), which the inset absorbs on a phone. */
export const COMPOSER_PAD = 8;
/** The collapsed sidebar rail's own bottom padding (`--gap-sm`), which the inset is added to. */
const RAIL_PAD = 6;
/** "Jump to latest" sits this far above the composer's top edge (lib/viewport-diagnostics.ts PILL_GAP). */
export const PILL_GAP = { min: 8, max: 16 } as const;
const EPSILON = 1;

/** Chat 4 + the pill 1; settings 3 and sessions 2; the keyboard 3; landscape chat 2 and settings 3. */
export const SAFE_AREA_GEOMETRY_CHECKS = 4 + 1 + 3 + 2 + 3 + 2 + 3;

export type InsetSimulation = 'cdp' | 'css';

export interface SafeAreaRun {
  readonly browser: Browser;
  readonly rootUrl: string;
  readonly scheme: 'light' | 'dark';
  readonly fail: (message: string) => never;
  /** The init script that makes `window.__harnessKeyboard(height)` move only the visual viewport. */
  readonly keyboardShim: string;
  /** Present: also capture the before/after evidence frames into this directory. */
  readonly captureDir?: string;
  /** How the home-indicator inset is made to exist; Chromium's real `env()` override by default. */
  readonly insetSimulation?: InsetSimulation;
}

export const IPHONE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export interface Measure {
  readonly innerHeight: number;
  /** The platform's bottom inset as the stylesheet read it (`--inset-bottom`). */
  readonly insetBottom: number;
  readonly shellBottom: number;
  readonly shellPaddingBottom: number;
  readonly inputBottom: number | null;
  readonly inputPaddingBottom: number | null;
  readonly composerTop: number | null;
  readonly composerBottom: number | null;
  readonly pillBottom: number | null;
  readonly tabbarBottom: number | null;
  readonly tabItemsBottom: number | null;
}

/** Measured once layout has settled: reduced motion still runs a 1ms transition on every element. */
export const measure = (page: Page): Promise<Measure> =>
  page.evaluate(async () => {
    // An infinite busy mark (a spinner's pulse) never finishes, and is not layout.
    const finite = document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY);
    await Promise.all(finite.map(animation => animation.finished.catch(() => undefined)));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const shell = document.querySelector('.kt-shell');
    if (!(shell instanceof HTMLElement)) throw new Error('no .kt-shell on the page');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;height:var(--inset-bottom,0px);width:1px';
    document.body.append(probe);
    const insetBottom = probe.getBoundingClientRect().height;
    probe.remove();
    const box = (selector: string): DOMRect | null => document.querySelector(selector)?.getBoundingClientRect() ?? null;
    const padOf = (selector: string): number | null => {
      const element = document.querySelector(selector);
      return element === null ? null : Number.parseFloat(getComputedStyle(element).paddingBottom);
    };
    const items = [...document.querySelectorAll('.kt-tabbar__item')];
    return {
      innerHeight: window.innerHeight,
      insetBottom,
      shellBottom: shell.getBoundingClientRect().bottom,
      shellPaddingBottom: Number.parseFloat(getComputedStyle(shell).paddingBottom),
      inputBottom: box('.fy-chat-input')?.bottom ?? null,
      inputPaddingBottom: padOf('.fy-chat-input'),
      composerTop: box('.fy-chat-input .fy-composer')?.top ?? null,
      composerBottom: box('.fy-chat-input .fy-composer')?.bottom ?? null,
      pillBottom: box('.fy-jump-latest')?.bottom ?? null,
      tabbarBottom: box('.kt-tabbar')?.bottom ?? null,
      tabItemsBottom: items.length === 0 ? null : Math.max(...items.map(item => item.getBoundingClientRect().bottom)),
    };
  });

/** Stands in for the platform's inset report where the engine cannot make one (`css`). */
const cssInsetScript = (insets: Insets): string => `(() => {
  const apply = () => {
    const style = document.createElement('style');
    style.dataset.harnessInsets = '';
    style.textContent = ':root:root{--inset-top:${insets.top}px;--inset-bottom:${insets.bottom}px}';
    document.head.append(style);
  };
  if (document.head) apply();
  else document.addEventListener('DOMContentLoaded', apply, { once: true });
})();`;

export interface OpenOptions {
  readonly browser: Browser;
  readonly rootUrl: string;
  readonly scheme: 'light' | 'dark';
  readonly keyboardShim: string;
  readonly insetSimulation: InsetSimulation;
  readonly userAgent?: string;
  readonly isMobile?: boolean;
  /** Extra init script, e.g. one that answers `display-mode: standalone`. */
  readonly initScript?: string;
}

/** A fresh, network-sealed context on `screen` with its insets simulated, at `query`, handed to `work`. */
export async function openScreen(
  options: OpenOptions,
  screen: Screen,
  query: string,
  work: (page: Page) => Promise<void>,
): Promise<void> {
  const mobile = options.isMobile ?? true;
  const context: BrowserContext = await options.browser.newContext({
    viewport: { width: screen.width, height: screen.height },
    deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    colorScheme: options.scheme,
    reducedMotion: 'reduce',
  });
  try {
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== new URL(options.rootUrl).origin) await route.abort();
      else await route.continue();
    });
    await context.addInitScript(options.keyboardShim);
    if (options.initScript !== undefined) await context.addInitScript(options.initScript);
    if (options.insetSimulation === 'css') await context.addInitScript(cssInsetScript(screen.insets));
    const page = await context.newPage();
    if (options.insetSimulation === 'cdp') {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: screen.insets });
    }
    await page.goto(`${options.rootUrl}${query}`);
    if (query.startsWith('#')) await page.reload();
    await page.locator('.kt-shell').first().waitFor({ state: 'visible' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await work(page);
  } finally {
    await context.close();
  }
}

/** Scrolls the transcript away from its tail the way a reader does, so "Jump to latest" appears. */
export async function detachTranscript(page: Page): Promise<void> {
  await page.evaluate(() => {
    const transcript = document.querySelector('.fy-transcript');
    if (!(transcript instanceof HTMLElement)) throw new Error('no transcript on the page');
    // A wheel is the reader's intent; the scroll that follows is then theirs, not a layout shift.
    transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true }));
    transcript.scrollTop = 0;
  });
  await page.locator('.fy-jump-latest').waitFor({ state: 'visible' });
}

export const keyboard = (page: Page, height: number | null): Promise<void> =>
  page.evaluate(
    h => (window as unknown as { __harnessKeyboard: (n: number | null) => void }).__harnessKeyboard(h),
    height,
  );

export async function runSafeAreaGeometry(run: SafeAreaRun): Promise<number> {
  const { scheme } = run;
  const fail: (message: string) => never = run.fail;
  let checks = 0;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON;
  const pass = (where: string, what: string): void => {
    checks += 1;
    process.stdout.write(`   safe area @ ${where}: ${what}\n`);
  };
  const options: OpenOptions = {
    browser: run.browser,
    rootUrl: run.rootUrl,
    scheme,
    keyboardShim: run.keyboardShim,
    insetSimulation: run.insetSimulation ?? 'cdp',
    userAgent: IPHONE_USER_AGENT,
  };
  const open = (screen: Screen, query: string, work: (page: Page) => Promise<void>) =>
    openScreen(options, screen, query, work);

  const frame = async (page: Page, name: string): Promise<void> => {
    if (run.captureDir !== undefined)
      await page.screenshot({ path: join(run.captureDir, `safe-area-${name}-${scheme}.png`) });
  };

  const insetWhere = (screen: Screen): string => `${screen.width}x${screen.height}`;

  // 1. The chat: the composer dock owns the inset, absorbs its own padding into it, and the shell pays nothing.
  await open(PORTRAIT, '#session-workspace', async page => {
    await page.locator('.fy-chat-input').waitFor({ state: 'visible' });
    const at = await measure(page);
    const where = `${insetWhere(PORTRAIT)} chat`;
    if (!near(at.insetBottom, PORTRAIT.insets.bottom))
      fail(
        `the harness did not simulate the inset: --inset-bottom is ${at.insetBottom}px, wanted ${PORTRAIT.insets.bottom}px`,
      );
    if (at.shellPaddingBottom !== 0)
      fail(`${where}: the shell pays ${at.shellPaddingBottom}px under a composer that already owns the inset`);
    pass(where, 'the shell pays nothing under the composer');
    if (!near(at.inputPaddingBottom ?? Number.NaN, Math.max(COMPOSER_PAD, at.insetBottom)))
      fail(
        `${where}: the composer dock pays ${at.inputPaddingBottom}px, wanted max(${COMPOSER_PAD}, ${at.insetBottom}) — the inset absorbing its own padding`,
      );
    pass(where, `composer dock pays the inset once (${at.inputPaddingBottom}px), its own ${COMPOSER_PAD}px absorbed`);
    if (!near(at.inputBottom ?? Number.NaN, at.innerHeight))
      fail(`${where}: the composer dock ends ${at.innerHeight - (at.inputBottom ?? 0)}px short of the screen edge`);
    pass(where, 'composer dock reaches the screen edge');
    const gap = at.innerHeight - (at.composerBottom ?? Number.NaN);
    if (!near(gap, at.insetBottom))
      fail(
        `${where}: the composer ends ${gap}px above the screen edge — one inset is ${at.insetBottom}px, so ${gap - at.insetBottom}px is dead space`,
      );
    pass(where, `composer ends ${gap}px above the edge (= the one inset)`);
    await frame(page, 'chat');

    // 1b. "Jump to latest" belongs to the composer: just above its top edge, wherever the composer is.
    await detachTranscript(page);
    const detached = await measure(page);
    const pillGap = (detached.composerTop ?? Number.NaN) - (detached.pillBottom ?? Number.NaN);
    if (!(pillGap >= PILL_GAP.min - EPSILON && pillGap <= PILL_GAP.max + EPSILON))
      fail(`${where}: "Jump to latest" sits ${pillGap}px above the composer, wanted ${PILL_GAP.min}–${PILL_GAP.max}px`);
    pass(where, `"Jump to latest" sits ${pillGap}px above the composer`);
    await frame(page, 'chat-jump');
  });

  // 2. The tab bar: it owns the inset, its surface reaches the edge, its buttons clear the indicator by one inset.
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
      if (!near(clear, at.insetBottom))
        fail(
          `${where}: the tab buttons end ${clear}px above the edge — exactly one inset (${at.insetBottom}px) belongs there`,
        );
      pass(where, `tab buttons clear the indicator by one inset (${clear}px)`);
      if (destination === 'settings') await frame(page, 'settings');
      else await frame(page, 'sessions');
      if (destination === 'settings') {
        // The keyboard hides the indicator: nothing may keep reserving one.
        await keyboard(page, KEYBOARD_VISUAL_HEIGHT);
        await page.waitForFunction(() => document.documentElement.dataset.keyboard === 'open');
        const up = await measure(page);
        if (up.shellPaddingBottom !== 0)
          fail(`${where}: with the keyboard up the shell still reserves ${up.shellPaddingBottom}px`);
        pass(where, 'keyboard up: the shell reserves nothing');
      }
    });

  // 3. The keyboard opens and closes over the chat: no inset left above the keys, and it comes back.
  await open(PORTRAIT, '#session-workspace', async page => {
    await page.locator('.fy-chat-input').waitFor({ state: 'visible' });
    const where = `${insetWhere(PORTRAIT)} chat keyboard`;
    await keyboard(page, KEYBOARD_VISUAL_HEIGHT);
    await page.waitForFunction(() => document.documentElement.dataset.keyboard === 'open');
    const up = await measure(page);
    if (!near(up.shellBottom, KEYBOARD_VISUAL_HEIGHT))
      fail(
        `${where}: the shell ends at ${up.shellBottom}px, not at the visible viewport (${KEYBOARD_VISUAL_HEIGHT}px)`,
      );
    pass(where, 'the shell follows the visible box above the keyboard');
    const above = up.shellBottom - (up.composerBottom ?? Number.NaN);
    if (!near(above, COMPOSER_PAD))
      fail(
        `${where}: ${above}px sits between the composer and the keyboard, wanted only its own ${COMPOSER_PAD}px — the home-indicator inset is still reserved`,
      );
    pass(where, `composer sits ${above}px above the keyboard (its own padding only)`);
    await frame(page, 'chat-keyboard');
    await keyboard(page, null);
    await page.waitForFunction(() => document.documentElement.dataset.keyboard === undefined);
    const closed = await measure(page);
    const gap = closed.innerHeight - (closed.composerBottom ?? Number.NaN);
    if (!near(gap, closed.insetBottom))
      fail(
        `${where}: after the keyboard closed the composer ends ${gap}px above the edge, wanted ${closed.insetBottom}px`,
      );
    pass(where, 'keyboard closed: the one inset is back and nothing is left over');
  });

  // 4. Rotation: wider than a phone, no column leaves the page ground showing under its surface — the shell pays
  //    nothing and each column pays landscape's shorter inset for its own content.
  for (const destination of ['chat', 'settings'] as const)
    await open(LANDSCAPE, destination === 'chat' ? '#session-workspace' : '?app-chrome=settings', async page => {
      const where = `${insetWhere(LANDSCAPE)} ${destination}`;
      const at = await measure(page);
      if (at.shellPaddingBottom !== 0)
        fail(`${where}: the shell pays ${at.shellPaddingBottom}px, leaving the page ground showing under the columns`);
      pass(where, 'the shell pays nothing, so no column stops short of the edge');
      const columns = await page.evaluate(() => {
        const read = (selector: string) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return null;
          return {
            bottom: element.getBoundingClientRect().bottom,
            pad: Number.parseFloat(getComputedStyle(element).paddingBottom),
            rail: element.dataset.sessionsBar === 'rail',
          };
        };
        return { sidebar: read('[data-sessions-bar]'), main: read('[data-shell-main]'), height: window.innerHeight };
      });
      if (destination === 'chat') {
        const gap = at.innerHeight - (at.composerBottom ?? Number.NaN);
        if (!near(gap, LANDSCAPE.insets.bottom + COMPOSER_PAD))
          fail(`${where}: the composer ends ${gap}px above the edge, wanted the inset plus its own ${COMPOSER_PAD}px`);
        pass(where, `composer ends ${gap}px above the edge (the inset, then its own padding)`);
      } else {
        if (columns.sidebar === null) fail(`${where}: no sessions column on the page`);
        if (!near(columns.sidebar.bottom, columns.height))
          fail(
            `${where}: the sidebar's surface ends ${columns.height - columns.sidebar.bottom}px short of the screen edge`,
          );
        const ownPad = columns.sidebar.rail ? RAIL_PAD : 0;
        if (!near(columns.sidebar.pad, LANDSCAPE.insets.bottom + ownPad))
          fail(
            `${where}: the sidebar pays ${columns.sidebar.pad}px, wanted the inset (${LANDSCAPE.insets.bottom}px) plus its own ${ownPad}px`,
          );
        pass(
          where,
          `the sidebar's surface reaches the edge and pays the inset once (${columns.sidebar.pad}px incl. its own ${ownPad}px)`,
        );
        if (at.tabbarBottom !== null) fail(`${where}: a tab bar is showing on a screen wider than a phone`);
        pass(where, 'no tab bar at this width');
      }
      await frame(page, `landscape-${destination}`);
    });

  return checks;
}
