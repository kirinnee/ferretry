/**
 * THE ACCESSIBLE STYLE'S 44 x 44 PX TARGET PROMISE, MEASURED on the real shared controls (PR 2632 review, MUST 1): the Dialog's
 * Close, the settings nav links, a terminal's Replay, a Button (both sizes) and an icon-only Button, at a phone (390, coarse
 * pointer) and a desktop (1440), in light and dark. Every one of them must be at least 44 x 44 under Accessible: a style that
 * only sets its own control heights leaves the controls that read `--target-floor` (or a fixed padding) below the promise.
 * Each case runs in the default look and with every radius at the 22px cap. Set `FY_ACCESSIBLE_TARGETS_SHOTS_DIR` to keep `<rounding>-<viewport>-<scheme>.png`.
 */
import { afterAll, beforeAll, expect, it, setDefaultTimeout } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const conversationScenes = resolve(packageRoot, '../../../plugins/conversation/tests/integration/app/fixtures');
const conversationRoot = resolve(conversationScenes, '../../../..');
const shotsDir = process.env.FY_ACCESSIBLE_TARGETS_SHOTS_DIR ?? '';
const TARGET = 44;
/** Every control the scene marks, and how many of each it must find (so a control that vanished is a failure, not a pass). */
const EXPECTED = { 'settings-nav-link': 2, button: 1, 'button-sm': 1, 'icon-button': 1 } as const;

const hypermediaCss = async (): Promise<string> => {
  const root = dirname(createRequire(join(conversationRoot, 'package.json')).resolve('durian-hypermedia/package.json'));
  const { buildCss } = (await import(join(root, 'scripts/build-css.ts'))) as { buildCss: () => string };
  return `${buildCss()}\n${await readFile(join(conversationRoot, 'app/hypermedia/dh-theme.css'), 'utf8')}`;
};

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-accessible-targets-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(conversationScenes, 'accessible-targets-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the targets scene did not build (${code}):\n${stderr}\n${stdout}`);
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

interface Box {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

const VIEWPORTS = [
  { name: '390', width: 390, height: 1_000, phone: true },
  { name: '1440', width: 1_440, height: 1_000, phone: false },
] as const;

/** The default look, and every radius at the cap (`--radius-cap`, 22px) the theme standard writes every surface for. */
const ROUNDINGS = [
  { name: 'default', css: '' },
  {
    name: 'round',
    css: ":root[data-style='accessible']{--radius-xs:22px;--radius-sm:22px;--radius-md:22px;--radius-lg:22px;--radius-control:22px;--radius-panel:22px;--radius-badge:22px;--radius-tab:22px;--radius-input:22px;--menu-radius:22px;--hm-radius:22px}",
  },
] as const;

for (const rounding of ROUNDINGS)
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`accessible ${rounding.name} ${viewport.name} ${scheme}: every shared control is at least ${TARGET} x ${TARGET}`, async () => {
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
          await tab.goto(`${origin}/?style=accessible&palette=contrast&mode=${scheme}`);
          await tab.addStyleTag({
            content: '*,*::before,*::after{transition:none!important;animation:none!important}',
          });
          if (rounding.css !== '') await tab.addStyleTag({ content: rounding.css });
          await tab.waitForSelector('.fy-dialog__close');
          await tab.waitForSelector('.dh-doc .term .ctl button, .dh-doc .term .ctl [role="button"]');
          await tab.evaluate(async () => await document.fonts.ready);
          if (shotsDir !== '')
            await tab.screenshot({
              path: join(shotsDir, `${rounding.name}-${viewport.name}-${scheme}.png`),
              fullPage: true,
            });
          const boxes = await tab.evaluate((): Box[] => {
            const read = (name: string, element: Element): Box => {
              const rect = element.getBoundingClientRect();
              return { name, width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
            };
            const out: Box[] = [];
            for (const element of document.querySelectorAll('[data-target]'))
              out.push(read(element.getAttribute('data-target') ?? '', element));
            for (const element of document.querySelectorAll('.fy-dialog__close'))
              out.push(read('dialog-close', element));
            for (const element of document.querySelectorAll(
              '.dh-doc .term .ctl button, .dh-doc .term .ctl [role="button"]',
            ))
              out.push(read('terminal-replay', element));
            return out;
          });
          for (const [name, count] of Object.entries({ ...EXPECTED, 'dialog-close': 1, 'terminal-replay': 1 }))
            expect(boxes.filter(box => box.name === name).length, `${name} is on the page`).toBeGreaterThanOrEqual(
              count,
            );
          const small = boxes.filter(box => box.width < TARGET || box.height < TARGET);
          expect(small, small.map(box => `${box.name} is ${box.width} x ${box.height}`).join('\n')).toEqual([]);
        } finally {
          await context.close();
        }
      });
