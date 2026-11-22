/**
 * C59 follow-up (audit row "Voice / Engine list scrolled against the sticky footer"): on a phone the step footer is sticky, and a
 * page control that is its own layer (the engine card's Install is z-index 2) must never be drawn, or take a click, over it.
 * The ASSERT is a HIT TEST, not a z-index value: with the whole engine list open the page is scrolled in steps, and at every step
 *   - the centre of each footer button, and the overlap of the footer with every card button under it, resolve to the footer;
 *   - at least one step puts an Install button under the footer (so the test would catch the regression it guards).
 * Chromium at 390 x 844 (the sticky footer is a phone rule), light and dark, over fake data
 * (`fixtures/voice-step-scene.tsx`). Set `FY_VOICE_FOOTER_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_VOICE_FOOTER_SHOTS_DIR ?? '';
let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-voice-footer-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/voice-step-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the Voice step scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

interface Sweep {
  readonly steps: number;
  readonly overlaps: number;
  readonly misses: string[];
}

/** Scroll the page's scroller in steps; at each, hit-test the footer buttons and every card button that overlaps the footer. */
const sweep = (): Sweep => {
  const footer = document.querySelector('[data-step-footer]') as HTMLElement;
  const card = document.querySelector('.fy-engine-card') as HTMLElement;
  let scroller: HTMLElement | null = card.parentElement;
  while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
  const target = scroller ?? (document.scrollingElement as HTMLElement);
  const misses: string[] = [];
  let overlaps = 0;
  let steps = 0;
  const limit = target.scrollHeight - target.clientHeight;
  for (let top = 0; top <= limit + 40; top += 40) {
    target.scrollTop = Math.min(top, limit);
    steps += 1;
    const f = footer.getBoundingClientRect();
    for (const button of footer.querySelectorAll('button')) {
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit === null || !button.contains(hit)) misses.push(`footer button "${button.textContent}" at scroll ${top}`);
    }
    for (const control of document.querySelectorAll(
      '.fy-engine-card button, .fy-engine-card input, .fy-engine-card a',
    )) {
      if (footer.contains(control)) continue;
      const r = control.getBoundingClientRect();
      const left = Math.max(r.left, f.left);
      const right = Math.min(r.right, f.right);
      const topEdge = Math.max(r.top, f.top);
      const bottom = Math.min(r.bottom, f.bottom);
      if (right - left < 2 || bottom - topEdge < 2) continue;
      overlaps += 1;
      const hit = document.elementFromPoint((left + right) / 2, (topEdge + bottom) / 2);
      if (hit === null || !footer.contains(hit))
        misses.push(`"${control.textContent?.trim() || control.className}" paints over the footer at scroll ${top}`);
    }
  }
  return { steps, overlaps, misses };
};

describe('C59 follow-up: the Voice sticky footer is above every engine control (hit test)', () => {
  for (const theme of ['studio-light', 'studio-dark'] as const)
    it(`scrolling the open engine list under the footer, the footer takes every hit (390, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
      });
      const origin = server?.url.origin ?? '';
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
      );
      const tab = await context.newPage();
      try {
        await tab.goto(`${origin}/?theme=${theme}&phone=1&view=voice`);
        await tab.locator('.fy-engine-card').first().waitFor({ state: 'visible' });
        await tab.getByText('Show every engine').click();
        await tab.waitForFunction(() => document.querySelectorAll('.fy-engine-card').length === 10);
        const result = await tab.evaluate(sweep);
        expect(result.steps, 'the page scrolled').toBeGreaterThan(3);
        expect(result.overlaps, 'an engine control went under the footer at least once').toBeGreaterThan(0);
        expect(result.misses).toEqual([]);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `390-${theme}-voice-footer-hit.png`) });
      } finally {
        await context.close();
      }
    });
});
