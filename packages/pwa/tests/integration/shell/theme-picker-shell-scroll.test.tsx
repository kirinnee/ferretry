/**
 * THE FIXED SHELL MUST NOT MOVE WHEN A THEME OPTION IS FOCUSED.
 *
 * The reported bug: changing theme left the app "cut horizontally by half" — the
 * interface occupying part of the screen with bare surface below it, and no
 * gesture that brought it back.
 *
 * The cause is not a colour token and not `--app-h`; both were measured across
 * every family and mode and never moved. It is geometry. Every option in the
 * picker is a real radio hidden with `sr-only`, and `sr-only` is
 * `position: absolute`. An absolutely positioned box is clipped by an ancestor's
 * `overflow` only along its CONTAINING BLOCK chain — so while the group around
 * it was statically positioned, these radios skipped the picker's own scrollport
 * (and the settings page's) and their containing block became the nearest
 * positioned ancestor: `.kt-shell`, which is `position: fixed`.
 *
 * That is what breaks the app, in two steps. The shell acquires scrollable
 * overflow it must never have — it IS the visual viewport — and then a label
 * click focuses one of those radios and the browser's scroll-into-view scrolls
 * THE SHELL to reveal it. Measured on `main` before the fix: 91–435px in the
 * app-bar popover and 954–1067px on the settings page. `position: fixed` means
 * no reader gesture can scroll it back, which is why it reads as the app being
 * cut in half rather than as a page that scrolled.
 *
 * SO THIS TEST NEEDS A REAL BROWSER, and asserts three things per shape:
 *
 *   1. the shell has NO scrollable overflow — the structural precondition, and
 *      the one that fails loudly the moment a control escapes again;
 *   2. focusing the last option leaves the shell exactly where it was;
 *   3. the picker's own scrollport DID scroll. Without this a "fix" that simply
 *      made the shell unscrollable would pass while silently breaking the
 *      keyboard reader, who would tab to an option that never comes into view.
 *
 * Both shapes the picker ships in are covered: the constrained popover hung off
 * the app bar, and the unconstrained list inside a STATIC scrollport, which is
 * the settings page's shape and the one that produced the owner's screenshot.
 * The short viewport is not decoration — the popover only overflows a shell it
 * cannot fit in, and 844px hid a third of the defect.
 *
 * The stylesheet is the shipped one, compiled from `src/styles/index.css` with
 * the shipped Tailwind config, exactly as `theme-picker.visual.test.tsx` does:
 * this is a claim about rendered geometry, so a fixture sheet would prove
 * nothing.
 */

import { afterAll, beforeAll, describe, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Browser, chromium } from 'playwright-core';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';
import type { ThemeState } from '../../../src/hooks/use-theme.ts';
import {
  type ResolvedMode,
  THEME_FAMILIES,
  type ThemeFamilyId,
  type ThemeMode,
} from '../../../src/lib/theme-preferences.ts';
import { ThemeSettings } from '../../../src/shell/theme-toggle.tsx';

const packageDir = resolve(import.meta.dir, '../../..');

const FAMILY: ThemeFamilyId = 'studio';
const MODE: ThemeMode = 'dark';
const RESOLVED: ResolvedMode = 'dark';

const theme: ThemeState = {
  family: FAMILY,
  mode: MODE,
  textScale: 'default',
  resolved: RESOLVED,
  attr: `${FAMILY}-${RESOLVED}`,
  families: THEME_FAMILIES,
  textScaleSupported: true,
  setFamily: () => {},
  setMode: () => {},
  setTextScale: () => {},
};

/** The option a reader reaches last, and the one furthest down the escaped stack. */
const LAST_FAMILY = THEME_FAMILIES[THEME_FAMILIES.length - 1]?.id ?? FAMILY;

/**
 * `app-bar.tsx` hangs the picker off the trigger in an absolutely positioned
 * panel; `App.tsx` puts that inside the fixed shell. Transcribed rather than
 * imported because `ThemeToggle` owns the open/closed state and this test is
 * about the panel's contents, not about opening it.
 */
const POPOVER_PANEL_CLASS =
  'absolute right-0 top-full z-50 mt-1 w-[272px] rounded-panel border border-border bg-surface p-panel shadow-popover sm:w-[292px]';

/**
 * The settings page's scrollport, in the shape that matters here: `h-full` and
 * `overflow-y-auto`, and DELIBERATELY NOT positioned. A positioned scrollport
 * would contain the radios by itself and this shape would prove nothing about
 * the picker — production has exactly one page-level scroller and every other
 * surface the picker can land on is somebody else's markup.
 */
const SETTINGS_SCROLLPORT_CLASS = 'scroll-thin h-full min-h-0 w-full overflow-y-auto overscroll-contain px-panel pb-4';

/**
 * Theme is not the first section on that page — daemons, notifications, dictation
 * and the composer all come before it, and the page is roughly three screens tall
 * on a phone. A stand-in for them, because the option under test has to start
 * BELOW THE FOLD or the browser has nothing to scroll and the third assertion
 * would be vacuous at the tall viewport.
 */
const SECTIONS_ABOVE_THEME = '<div class="h-[1200px] shrink-0" aria-hidden="true"></div>';

/** The shell as `App.tsx` renders it on every daemon route. */
const SHELL_CLASS = 'kt-shell flex flex-col overflow-hidden';

const SHAPES = [
  {
    name: 'the app-bar popover',
    scrollport: '[aria-label="Theme family"]',
    body: `<div class="relative shrink-0 self-end">
             <div class="${POPOVER_PANEL_CLASS}" role="dialog" aria-label="Theme">
               ${renderToStaticMarkup(<ThemeSettings theme={theme} constrained />)}
             </div>
           </div>`,
  },
  {
    name: 'the settings page',
    scrollport: '[data-scrollport]',
    body: `<div class="relative min-h-0 min-w-0 flex-1 px-1">
             <main data-scrollport class="${SETTINGS_SCROLLPORT_CLASS}">
               ${SECTIONS_ABOVE_THEME}
               ${renderToStaticMarkup(<ThemeSettings theme={theme} />)}
             </main>
           </div>`,
  },
] as const;

/**
 * `--app-h` is written by `use-app-viewport.ts` in the app; here it is stated
 * outright, because this test is about what the shell does at a given height and
 * not about how that height is produced.
 */
const documentFor = (css: string, body: string, height: number): string => `<!doctype html>
<html lang="en" data-theme="${FAMILY}-${RESOLVED}" style="--app-h: ${height}px; --app-top: 0px">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <style>${css}</style>
  </head>
  <body>
    <div id="root">
      <div class="${SHELL_CLASS}" data-shell>${body}</div>
    </div>
  </body>
</html>`;

/**
 * Focuses the last family option the way a label click does — plainly, with no
 * `preventScroll` — and reports what moved. A `focus({ preventScroll: true })`
 * here would be this test agreeing with itself: the browser's own scroll is the
 * behaviour under test.
 */
const FOCUS_LAST = (family: string, scrollport: string): string => `(() => {
  const shell = document.querySelector('[data-shell]');
  const scrollport = document.querySelector(${JSON.stringify(scrollport)});
  const option = document.querySelector('input[data-family=' + JSON.stringify(${JSON.stringify(family)}) + ']');
  shell.scrollTop = 0;
  scrollport.scrollTop = 0;
  const overflowRoom = shell.scrollHeight - shell.clientHeight;
  const top = Math.round(shell.getBoundingClientRect().top);
  option.focus();
  return {
    overflowRoom,
    shellScrollTop: Math.round(shell.scrollTop),
    shellTop: top,
    shellTopAfter: Math.round(shell.getBoundingClientRect().top),
    scrollportScrollTop: Math.round(scrollport.scrollTop),
    scrollportRoom: scrollport.scrollHeight - scrollport.clientHeight,
  };
})()`;

interface ShellReading {
  readonly overflowRoom: number;
  readonly shellScrollTop: number;
  readonly shellTop: number;
  readonly shellTopAfter: number;
  readonly scrollportScrollTop: number;
  readonly scrollportRoom: number;
}

/**
 * 844 is a phone; 500 is a phone with its keyboard up, a short desktop window, or
 * a split view. The popover's own `max-h` keeps it inside 844, so a suite that
 * only tested the tall viewport measured the defect at a third of its size.
 */
const VIEWPORTS = [
  { name: 'a phone', width: 390, height: 844 },
  { name: 'a short window', width: 390, height: 500 },
] as const;

let workspace = '';
let browser: Browser | undefined;
let css = '';

const buildCss = (outFile: string): void => {
  const result = spawnSync(
    './node_modules/.bin/tailwindcss',
    [
      '--config',
      'tailwind.config.ts',
      '--input',
      'src/styles/index.css',
      '--output',
      outFile,
      '--content',
      './src/**/*.{ts,tsx},./tests/integration/shell/*.tsx',
    ],
    { cwd: packageDir, stdio: 'pipe' },
  );
  if (result.status !== 0) throw new Error(`tailwind build failed: ${result.stderr?.toString() ?? ''}`);
};

describe('the theme picker inside the fixed shell', () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'fy-shell-scroll-'));
    const outFile = join(workspace, 'app.css');
    buildCss(outFile);
    css = await readFile(outFile, 'utf8');
    const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
    should(chrome).be.type('string');
    browser = await chromium.launch({ executablePath: chrome as string, headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (workspace !== '') await rm(workspace, { recursive: true, force: true });
  });

  for (const shape of SHAPES) {
    for (const viewport of VIEWPORTS) {
      it(`should keep the shell still when an option is focused in ${shape.name} on ${viewport.name}`, async () => {
        const page = documentFor(css, shape.body, viewport.height);
        const server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
        });
        try {
          const context = await (browser as Browser).newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: 'dark',
            reducedMotion: 'reduce',
          });
          // A live daemon runs on the machine that executes this suite.
          await context.route('**/*', async route => {
            if (new URL(route.request().url()).origin !== server.url.origin) {
              await route.abort();
              return;
            }
            await route.continue();
          });
          try {
            const tab = await context.newPage();
            await tab.goto(server.url.toString());
            const reading = await tab.evaluate<ShellReading>(FOCUS_LAST(LAST_FAMILY, shape.scrollport));

            // 1. The shell is the visual viewport, so it has nothing to scroll.
            should(reading.overflowRoom).equal(0);
            // 2. And focusing an option did not move it.
            should(reading.shellScrollTop).equal(0);
            should(reading.shellTopAfter).equal(reading.shellTop);
            // 3. While the option was still brought into view where it lives.
            should(reading.scrollportRoom).be.above(0);
            should(reading.scrollportScrollTop).be.above(0);
          } finally {
            await context.close();
          }
        } finally {
          server.stop(true);
        }
      }, 120_000);
    }
  }
});
