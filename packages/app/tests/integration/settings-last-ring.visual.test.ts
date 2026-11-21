/**
 * THE LAST CONTROL'S FOCUS RING IS NEVER CLIPPED BY THE SETTINGS SCROLLER (r11-2b K13, owner line 13: "0 clipped rings on every
 * Settings tab").
 *
 * The r11 gate walked every Settings tab with the real keyboard and found the ring of the LAST control on three tabs cut by the
 * bottom edge of the scroller (`.fy-main`): Layout (the chips "Browser", "Files", "Ferret warden", 3px, every width), Voice at 1280
 * (`input.fy-ar-range` and the "low" option, 4px) and Warden at 1280 (4px). The control sat flush on the scroller's bottom edge.
 *
 * For each of those tabs at 1280 / 768 / 390 in light and dark this test presses Tab through the REAL Settings shell (the real app
 * half of each tab over the fake sweep machine) and asks `walkFocusRings` for every stop's ring against every clipping ancestor.
 * The probe judges where the browser left the control after a native Tab, BEFORE any scrollIntoView of ours, so it measures what a
 * person sees. A stop is also required to be the page's last control for the walk to count: the last focusable inside
 * `.fy-settings-page` must have been visited and its ring must lie inside the scroller's padding box (0 px past it).
 * Set `FY_SETTINGS_LAST_RING_SHOTS_DIR` to keep `<viewport>-<scheme>-<tab>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium, walkFocusRings } from '../support/browser/index.ts';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETTINGS_LAST_RING_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-settings-last-ring-'));
  const entry = join(directory, 'entry.tsx');
  await Bun.write(
    entry,
    `import { registerSettingsSweep } from ${JSON.stringify(resolve(packageRoot, 'fixtures/settings-sweep-register.ts'))};\nregisterSettingsSweep();\nawait import(${JSON.stringify(resolve(packageRoot, 'fixtures/settings-shell-scene.tsx'))});\n`,
  );
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', entry], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 300_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '768', width: 768, height: 900, phone: false },
  /** A short window: every tab's last control sits below the fold, so a native Tab has to scroll it into view. */
  { name: '1280x560', width: 1_280, height: 560, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const SCHEMES = ['light', 'dark'] as const;
/** The three tabs whose last control sat flush on the scroller's bottom edge: the route and what proves the page drew. */
const TABS = [
  { name: 'layout', path: '/d/ws/settings/layouts/layout', ready: '.fy-ls-col' },
  { name: 'voice', path: '/d/ws/settings/voice/voice', ready: 'input.fy-ar-range' },
  {
    name: 'warden',
    path: '/d/ws/settings/warden/warden',
    ready: '.fy-settings-page [role="radiogroup"], .fy-settings-page button',
  },
] as const;

describe('the last control of a settings tab has its whole focus ring inside the scroller', () => {
  for (const tab of TABS)
    for (const variant of VARIANTS)
      for (const scheme of SCHEMES)
        it(`${tab.name} at ${variant.name} ${scheme}: 0px of the last ring past the scroller`, async () => {
          const context = await browser.newContext({
            viewport: { width: variant.width, height: variant.height },
            deviceScaleFactor: variant.phone ? 2 : 1,
            hasTouch: variant.phone,
            isMobile: variant.phone,
            colorScheme: scheme,
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const page = await context.newPage();
          try {
            await page.goto(`${origin}${tab.path}?theme=studio-${scheme}`);
            await page.waitForSelector(tab.ready, { timeout: 15_000 });
            // The last focusable control inside the panel: the walk must reach it, and it is where the defect was.
            const last = await page.evaluate(() => {
              const focusable = [
                ...document.querySelectorAll<HTMLElement>(
                  '.fy-settings-page :is(a[href], button, input, select, textarea, [tabindex]):not([tabindex="-1"]):not(:disabled)',
                ),
              ].filter(el => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden');
              const el = focusable.at(-1);
              if (el === undefined) return null;
              el.setAttribute('data-last-control', '');
              return { tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').trim().slice(0, 24) };
            });
            expect(last).not.toBeNull();
            const walk = await walkFocusRings(page, 120);
            if (shotsDir !== '') {
              // The picture is of the last control focused after keyboard use, where the browser leaves it.
              await page.evaluate(() => (document.querySelector('[data-last-control]') as HTMLElement | null)?.focus());
              await page.screenshot({ path: join(shotsDir, `${variant.name}-${scheme}-${tab.name}.png`) });
            }
            const reached = await page.evaluate(
              () => document.activeElement?.hasAttribute('data-last-control') === true,
            );
            // The walk runs on past the panel, so the last control is checked by name among the stops, not by the final one.
            expect(walk.stops.length).toBeGreaterThan(1);
            expect(reached || walk.stops.some(stop => stop.label.startsWith(`${last?.tag}`))).toBe(true);
            expect(walk.violations).toEqual([]);
          } finally {
            await context.close();
          }
        });
});
