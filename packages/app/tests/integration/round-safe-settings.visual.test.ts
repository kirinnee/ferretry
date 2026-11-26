/**
 * EVERY SETTINGS TAB IS ROUND-SAFE (owner ask &B210, 2026-11-25: "for high rounded, we need to take that into consideration when
 * writing"). The REAL settings shell draws every tab of every shipped plugin (`fixtures/settings-shell-scene.tsx` over
 * `fixtures/settings-sweep-register.ts`, one fake machine) at a phone (390) and a desktop (1440), light and dark, in the default
 * look (Studio) and in the two roundest looks (Gen Z: pill controls and stacked colour shadows; Neumorphism: the widest radii and
 * the most padding), and asserts the geometric rule of `tests/support/browser/round-safe.ts`: no content leaves the inner
 * rounded rectangle of the box it sits in. The rule itself is the theme's (`styles/tokens/base-style.css`, "ROUND-SAFE GEOMETRY");
 * this is what keeps it true for the next tab somebody writes.
 *
 * `FY_ROUND_SAFE_ONLY=<plugin>[/<tab>],…` narrows the tabs; `FY_ROUND_SAFE_LOOKS=genz,studio` narrows the looks;
 * `FY_ROUND_SAFE_SHOTS_DIR` keeps `<look>-<viewport>-<scheme>-<plugin>-<tab>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { generated } from '../../src/generated/surfaces.ts';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';
import { describeRoundMisses, roundSafeMisses } from '../support/browser/round-safe.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ROUND_SAFE_SHOTS_DIR ?? '';
const only = (process.env.FY_ROUND_SAFE_ONLY ?? '').split(',').filter(Boolean);
const onlyLooks = (process.env.FY_ROUND_SAFE_LOOKS ?? '').split(',').filter(Boolean);

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-round-safe-settings-'));
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
  if (code !== 0) throw new Error(`the sweep scene did not build (${code}):\n${stderr}\n${stdout}`);
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

/** `palette` is each look's own default palette, so a look is drawn as its picker would draw it. */
const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
].filter(look => onlyLooks.length === 0 || onlyLooks.includes(look.style));
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 1_000, phone: false },
] as const;
const TABS = generated.surfaces
  .flatMap(entry => (entry.manifest.ui?.settings ?? []).map(tab => ({ plugin: entry.id, tab: tab.id })))
  .filter(item => only.length === 0 || only.includes(item.plugin) || only.includes(`${item.plugin}/${item.tab}`));

for (const look of LOOKS) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      describe(`round-safe settings: ${look.style} ${viewport.name} ${scheme}`, () => {
        for (const { plugin, tab } of TABS) {
          it(`${plugin}/${tab}`, async () => {
            const context = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              deviceScaleFactor: viewport.phone ? 2 : 1,
              hasTouch: viewport.phone,
              isMobile: viewport.phone,
              colorScheme: scheme,
              timezoneId: 'America/Los_Angeles',
              locale: 'en-US',
              reducedMotion: 'reduce',
            });
            try {
              const origin = server?.url.origin ?? '';
              await context.route('**/*', async route =>
                new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
              );
              const page = await context.newPage();
              await page.goto(`${origin}/d/ws/settings/${plugin}/${tab}?theme=${look.palette}-${scheme}`);
              await page.evaluate(style => document.documentElement.setAttribute('data-style', style), look.style);
              await page.waitForSelector('.fy-settings-page', { timeout: 20_000 });
              await page.waitForTimeout(900);
              await page.evaluate(async () => await document.fonts.ready);
              if (shotsDir !== '')
                await page.screenshot({
                  path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${plugin}-${tab}.png`),
                  fullPage: true,
                });
              const misses = await roundSafeMisses(page);
              expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
            } finally {
              await context.close();
            }
          });
        }
      });
    }
  }
}
