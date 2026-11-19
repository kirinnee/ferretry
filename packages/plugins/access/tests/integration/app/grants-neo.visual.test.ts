/**
 * THE GRANTS CARD UNDER NEO, on every palette in both modes (r10 T13 fix). Each axis is a row-shaped switch: a title that is
 * accent text when the axis is on, a helper line, and a round track. Neo's first polish styled every direct span of every
 * `role="switch"` as the switch's track, so the title took the accent fill (accent on accent, 1:1 on six palettes) and the
 * text spans were forced 14px wide. Neo now styles only the shared switch's own track and thumb, so this card keeps its look and
 * its text holds 4.5:1 against what is really behind it, whatever the palette.
 *
 * Set `FY_GRANTS_NEO_SHOTS_DIR` to keep `<palette>-<mode>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_PALETTE_IDS, sceneBuilder, sharedChromium, textContrast } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_GRANTS_NEO_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-grants-neo-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/grants-neo-scene.tsx'],
    {
      cwd: packageRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the grants-neo scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: auto !important; min-height: 0 !important; overflow: visible !important; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const PROBES = {
  /** The accent title of a switched-on axis: the text the first polish painted accent-on-accent. */
  onTitle: '[role="switch"][aria-checked="true"] span.block.font-semibold',
  /** The helper line under every title. */
  helper: '[role="switch"] span.block.text-muted',
} as const;

describe('the Grants card under Neo', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const palette of ALL_PALETTE_IDS) {
      it(`${palette}-${mode}: every title and helper reaches 4.5:1 and keeps its width`, async () => {
        const context = await browser.newContext({ viewport: { width: 1_280, height: 900 }, colorScheme: mode });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        tab.setDefaultTimeout(8_000);
        const problems: string[] = [];
        tab.on('pageerror', error => problems.push(error.message));
        try {
          await tab.goto(`${origin}/?style=neo&palette=${palette}&mode=${mode}`);
          await tab.waitForSelector('[data-scene] [role="switch"]');
          await tab.evaluate(async () => await document.fonts.ready);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${palette}-${mode}.png`), fullPage: true });
          if (shotsDir !== '') {
            await tab.setViewportSize({ width: 390, height: 844 });
            await tab.screenshot({ path: join(shotsDir, `${palette}-${mode}-390.png`), fullPage: true });
            await tab.setViewportSize({ width: 1_280, height: 900 });
          }
          expect(problems).toEqual([]);
          const report = await textContrast(tab, { within: '[data-scene] [role="switch"]', probes: PROBES });
          expect(report.checked).toBeGreaterThan(10);
          // The sample really holds both kinds of text (a missing one would pass vacuously).
          expect(report.probes.onTitle).toBeDefined();
          expect(report.probes.helper).toBeDefined();
          expect({ palette, mode, failures: report.failures }).toEqual({ palette, mode, failures: [] });
          // The text spans keep their natural width (they were forced 14px wide).
          const narrow = await tab.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('[data-scene] [role="switch"] span.block')]
              .map(span => ({ text: span.textContent ?? '', width: span.getBoundingClientRect().width }))
              .filter(span => span.width < 40),
          );
          expect({ palette, mode, narrow }).toEqual({ palette, mode, narrow: [] });
        } finally {
          await context.close();
        }
      });
    }
  }
});
