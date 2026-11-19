/**
 * THE WARDEN SETTINGS FORM in a real browser over a FIXED FAKE config (`fixtures/warden-form-scene.tsx`, no real login, key or
 * machine), inside the page rule `.fy-page label { display: block }` that once turned every flex label in a settings tab back
 * into a block. Checked at a phone (390) and a desktop (1280), light and dark:
 *  - every checkbox's box sits left of its words, and level with them when the words are one line;
 *  - the three layers sit in a row from 720px and stack below, with no box inside another;
 *  - the sweep interval draws no radio dot; the number inputs of a section share one right edge;
 *  - nothing scrolls sideways.
 * Set `FY_WARDEN_FORM_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_WARDEN_FORM_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-warden-form-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/warden-form-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the Warden form scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: auto !important; min-height: 0 !important; overflow: visible !important; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 1_000, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;
const STATES = ['all', 'rules'] as const;

describe('the Warden settings form, over a fake config', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const state of STATES) {
        it(`lays out ${state} (${viewport.name}, ${theme})`, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const tab = await context.newPage();
          try {
            await tab.goto(`${origin}/?theme=${theme}&state=${state}`);
            await tab.locator('[data-warden-form]').waitFor({ state: 'visible' });
            expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

            const checks = await tab.evaluate(() =>
              [...document.querySelectorAll<HTMLLabelElement>('label.fy-wf-check')].map(label => {
                const box = label.querySelector('input')?.getBoundingClientRect();
                const words = label.querySelector('.fy-wf-check__label')?.getBoundingClientRect();
                const detail = label.querySelector('.fy-wf-check__detail') !== null;
                return {
                  display: getComputedStyle(label).display,
                  left: (box?.right ?? 1) <= (words?.left ?? 0),
                  level: Math.abs(
                    (box?.top ?? 0) + (box?.height ?? 0) / 2 - ((words?.top ?? 0) + (words?.height ?? 0) / 2),
                  ),
                  detail,
                };
              }),
            );
            expect(checks.length).toBeGreaterThan(0);
            for (const check of checks) {
              expect(check.display).toBe('flex');
              expect(check.left).toBe(true);
              if (!check.detail) expect(check.level).toBeLessThanOrEqual(2);
            }

            // The sweep interval is a segmented choice: its radios are clipped to a pixel, never drawn as dots.
            const dots = await tab.evaluate(() =>
              [...document.querySelectorAll<HTMLInputElement>('.fy-wf-seg input')].map(
                input => input.getBoundingClientRect().width,
              ),
            );
            expect(dots.length).toBeGreaterThan(0);
            for (const width of dots) expect(width).toBeLessThanOrEqual(1);

            // Layers: three in a row from 720px, stacked below; none holds another box.
            const layers = await tab.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>('.fy-wf-layer')].map(layer => ({
                top: Math.round(layer.getBoundingClientRect().top),
                inner: [...layer.querySelectorAll<HTMLElement>('div, p, label, fieldset, li')].some(
                  el => parseFloat(getComputedStyle(el).borderTopWidth) > 0,
                ),
              })),
            );
            expect(layers).toHaveLength(3);
            expect(new Set(layers.map(layer => layer.top)).size).toBe(viewport.phone ? 3 : 1);
            for (const layer of layers) expect(layer.inner).toBe(false);

            // Number inputs of one section share a right edge.
            const edges = await tab.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>('.fy-wf-fields')].map(group =>
                [...group.querySelectorAll('input')].map(input => Math.round(input.getBoundingClientRect().right)),
              ),
            );
            for (const group of edges) expect(new Set(group).size).toBe(1);

            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-${state}.png`), fullPage: true });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});
