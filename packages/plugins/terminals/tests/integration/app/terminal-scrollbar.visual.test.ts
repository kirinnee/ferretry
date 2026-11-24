/**
 * THE TERMINAL'S SCROLLBACK SLIDER IS SEEN (O9-7). xterm 6 draws its own slider (a DOM element on the scrollable wrapper, not a native
 * bar), coloured from the theme it is given, and its default (the ink at 20%) sinks into the terminal's own background. The plugin's
 * `terminalTheme()` hands it the app's code-surface thumb instead. Over a REAL xterm with a 200-line scrollback
 * (`fixtures/xterm-scrollback-scene.tsx`), with classic scrollbars drawn, light and dark, in a pale and a navy-code palette: the slider is
 * on screen after a wheel scroll, and the rendered contrast of its fill over the terminal's background is at least 3:1.
 *
 * `FY_TERMINAL_SCROLLBAR_SHOTS_DIR=<dir>` keeps `<scheme>-<palette>.png` (local evidence for the PR, never committed).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { chromium } from 'playwright-core';
import { COLOUR_TOOLS, type ColourTools, sceneBuilder } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_TERMINAL_SCROLLBAR_SHOTS_DIR ?? '';
/** A graphic object's contrast floor (WCAG 1.4.11). */
const THUMB_FLOOR = 3;

let drawn: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-terminal-scrollbar-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/xterm-scrollback-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the terminal scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-bg text-fg" style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  // The shared Chromium keeps Playwright's `--hide-scrollbars`, which would hide the very thing under test.
  drawn = await chromium.launch({
    executablePath: Bun.which('google-chrome') ?? Bun.which('chromium') ?? undefined,
    headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'],
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  await drawn?.close();
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

describe('the real xterm scrollback slider', () => {
  for (const scheme of ['light', 'dark'] as const)
    for (const palette of ['studio', 'briefing'])
      it(`${palette}, ${scheme}: the slider is on screen and holds ${THUMB_FLOOR}:1 over the terminal`, async () => {
        const context = await drawn.newContext({ viewport: { width: 800, height: 400 }, colorScheme: scheme });
        const tab = await context.newPage();
        try {
          await tab.goto(`http://127.0.0.1:${server?.port}/?palette=${palette}&mode=${scheme}`);
          await tab.waitForFunction(() => '__xterm' in window, undefined, { timeout: 30_000 });
          await tab.evaluate(COLOUR_TOOLS);
          // Scroll the scrollback with the wheel, as a person does: xterm shows its slider while it moves.
          await tab.mouse.move(100, 100);
          await tab.mouse.wheel(0, -400);
          await tab.waitForTimeout(400);
          const result = await tab.evaluate(() => {
            const tools = (window as unknown as { __colour: ColourTools }).__colour;
            const bar = document.querySelector('.xterm-scrollable-element > .scrollbar.vertical') as HTMLElement | null;
            const slider = bar?.querySelector('.slider') as HTMLElement | null;
            if (bar === null || slider === null) return null;
            const rect = slider.getBoundingClientRect();
            const thumb = tools.rgba(getComputedStyle(slider).backgroundColor);
            const surface = tools.backdrop(bar.parentElement as HTMLElement);
            return {
              visible: getComputedStyle(bar).opacity === '1' && rect.width > 0 && rect.height > 0,
              ratio: tools.ratio(tools.over(thumb, [...surface, 1]), surface),
            };
          });
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${scheme}-${palette}.png`) });
          expect(result, 'xterm draws a vertical slider').not.toBeNull();
          expect(result?.visible, 'the slider is on screen').toBe(true);
          expect(result?.ratio ?? 0, 'the slider over the terminal').toBeGreaterThanOrEqual(THUMB_FLOOR);
        } finally {
          await context.close();
        }
      });
});
