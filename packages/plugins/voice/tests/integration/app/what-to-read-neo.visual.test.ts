/**
 * VOICE'S "WHAT TO READ" UNDER NEO, on every palette in both modes (r10 T13 fix). It is a radio group of cards, not a Segmented
 * control: the chosen card is an accent-soft block with accent text and a muted description. Neo's first polish styled EVERY
 * `role="radiogroup"` as a Segmented control, so the chosen card went yellow while its description kept the muted colour
 * (1.35:1 on Neo dark, 1.66 / 1.51:1 on High Contrast). Neo now styles only a control that says it is segmented, so this group
 * keeps its own colours and every word in it holds 4.5:1.
 *
 * Set `FY_WHAT_TO_READ_NEO_SHOTS_DIR` to keep `<palette>-<mode>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_PALETTE_IDS, sceneBuilder, sharedChromium, textContrast } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_WHAT_TO_READ_NEO_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-what-to-read-neo-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/what-to-read-neo-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the what-to-read-neo scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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
  /** The chosen card's description: the text that fell to 1.35:1. */
  chosenDescription: '[role="radiogroup"][aria-labelledby="auto-read-what"] label:has(:checked) span.text-meta',
  /** An unchosen card's label. */
  otherLabel: '[role="radiogroup"][aria-labelledby="auto-read-what"] label:not(:has(:checked)) span.text-ui',
} as const;

describe("Voice's What to read under Neo", () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const palette of ALL_PALETTE_IDS) {
      it(`${palette}-${mode}: the chosen and unchosen cards reach 4.5:1`, async () => {
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
          await tab.waitForSelector('[data-scene] [aria-labelledby="auto-read-what"]');
          await tab.evaluate(async () => await document.fonts.ready);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${palette}-${mode}.png`), fullPage: true });
          if (shotsDir !== '') {
            await tab.setViewportSize({ width: 390, height: 844 });
            await tab.screenshot({ path: join(shotsDir, `${palette}-${mode}-390.png`), fullPage: true });
            await tab.setViewportSize({ width: 1_280, height: 900 });
          }
          expect(problems).toEqual([]);
          const report = await textContrast(tab, {
            within: '[data-scene] [aria-labelledby="auto-read-what"]',
            probes: PROBES,
          });
          expect(report.checked).toBeGreaterThan(2);
          // The sample really holds both kinds of card text (a missing one would pass vacuously).
          expect(report.probes.chosenDescription).toBeDefined();
          expect(report.probes.otherLabel).toBeDefined();
          expect({ palette, mode, failures: report.failures }).toEqual({ palette, mode, failures: [] });
        } finally {
          await context.close();
        }
      });
    }
  }
});
