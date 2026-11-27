/**
 * THE COMPONENT SPECIMEN IS ROUND-SAFE (owner ask &B210, 2026-11-25). The theme matrix's specimen page (cards, callouts, menus, fields,
 * tables, code blocks, buttons: `plugins/conversation/tests/integration/app/fixtures/theme-matrix-scene.tsx`) is drawn at a phone (390)
 * and a desktop (1440), light and dark, in the default look and in every look that rounds, and the geometric rule of
 * `tests/support/browser/round-safe.ts` holds on it: no content leaves the inner rounded rectangle of the box it sits in.
 * Set `FY_ROUND_SAFE_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>-specimen.png`.
 */
import { afterAll, beforeAll, expect, it, setDefaultTimeout } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';
import { describeRoundMisses, roundSafeMisses } from '../support/browser/round-safe.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const conversationScenes = resolve(packageRoot, '../../../plugins/conversation/tests/integration/app/fixtures');
const conversationRoot = resolve(conversationScenes, '../../../..');
const shotsDir = process.env.FY_ROUND_SAFE_SHOTS_DIR ?? '';
const onlyLooks = (process.env.FY_ROUND_SAFE_LOOKS ?? '').split(',').filter(Boolean);

/** Durian's stylesheet as the app's Vite plugin builds it, then `dh-theme.css`, in the order `dh-styles.ts` imports them. */
const hypermediaCss = async (): Promise<string> => {
  const root = dirname(createRequire(join(conversationRoot, 'package.json')).resolve('durian-hypermedia/package.json'));
  const { buildCss } = (await import(join(root, 'scripts/build-css.ts'))) as { buildCss: () => string };
  return `${buildCss()}\n${await readFile(join(conversationRoot, 'app/hypermedia/dh-theme.css'), 'utf8')}`;
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-round-safe-specimen-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(conversationScenes, 'theme-matrix-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the specimen scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${await hypermediaCss()}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  browser = await sharedChromium();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

/** Each look with its own default palette, so a look is drawn as its picker would draw it. */
const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
  { style: 'glass', palette: 'aurora' },
  { style: 'lucid', palette: 'mesh' },
  { style: 'briefing', palette: 'briefing' },
  { style: 'accessible', palette: 'contrast' },
].filter(look => onlyLooks.length === 0 || onlyLooks.includes(look.style));
const VIEWPORTS = [
  { name: '390', width: 390, height: 2_400, phone: true },
  { name: '1440', width: 1_440, height: 2_400, phone: false },
] as const;

for (const look of LOOKS) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`${look.style} ${viewport.name} ${scheme}: no content leaves the inner rounded rectangle of its box`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
          colorScheme: scheme,
          reducedMotion: 'reduce',
        });
        try {
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          await tab.goto(`${origin}/?style=${look.style}&palette=${look.palette}&mode=${scheme}`);
          await tab.addStyleTag({
            content: '*,*::before,*::after{transition:none!important;animation:none!important}',
          });
          await tab.waitForSelector('[role="menu"] [role="menuitem"]');
          await tab.waitForSelector('[data-probe="hypermedia"] .dh-doc .term');
          await tab.waitForSelector('[data-probe="hypermedia"] .dh-doc .callout');
          await tab.evaluate(async () => await document.fonts.ready);
          if (shotsDir !== '')
            await tab.screenshot({
              path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-specimen.png`),
              fullPage: true,
            });
          const misses = await roundSafeMisses(tab);
          expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
}
