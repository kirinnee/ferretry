/**
 * A SECOND REFUSAL OF A RETRIED ANSWER IS SAID ON THE DECK THE READER IS ON, in a real browser, at 390 and 1440, light and
 * dark, at the default and the highest rounding. The reader answers one item, is refused, retries, and is refused again
 * while reading the next item: the refusal shows on that deck, with a way to dismiss it.
 *
 * Set `FY_INBOX_SECOND_REFUSAL_SHOTS_DIR` to keep `<viewport>-<scheme>-<rounding>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_INBOX_SECOND_REFUSAL_SHOTS_DIR ?? '';

/** Every radius token the app draws with, set to the pill: what the highest rounding does to a surface. */
const RADII = [
  'radius-xs',
  'radius-sm',
  'radius-md',
  'radius-lg',
  'radius-control',
  'radius-panel',
  'radius-badge',
  'radius-tab',
  'radius-input',
  'radius-pill',
  'card-radius',
  'menu-radius',
];

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-inbox-second-refusal-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/inbox-second-refusal-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the second-refusal scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 7489,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;

describe('a second refusal on the deck the reader is on', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const rounding of ['default', 'highest'] as const)
        it(`says the retried answer's second refusal beside the open item (${viewport.name}, ${scheme}, ${rounding})`, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: scheme,
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
            reducedMotion: 'reduce',
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          try {
            const tab = await context.newPage();
            await tab.goto(`${origin}/?theme=studio-${scheme}`);
            await tab.waitForSelector('[data-inbox-open], .fy-attn-deck__top');
            if (rounding === 'highest')
              await tab.evaluate(names => {
                for (const name of names)
                  document.documentElement.style.setProperty(`--${name}`, 'var(--radius-round)');
              }, RADII);
            await tab.evaluate(async () => document.fonts.ready);
            expect(await tab.$('[data-agenda-failures]'), 'nothing refused yet').toBeNull();
            await tab.evaluate(() => window.secondRefusal.refuseTwice());
            const failures = await tab.waitForSelector('[data-agenda-failures]', { timeout: 5_000 });
            expect(await failures.textContent()).toContain('The machine said no again.');
            await tab.evaluate(
              () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
            );
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${rounding}.png`) });
            const box = await failures.boundingBox();
            expect(box?.x ?? -1, 'inside the screen, left').toBeGreaterThanOrEqual(0);
            expect((box?.x ?? 0) + (box?.width ?? 0), 'inside the screen, right').toBeLessThanOrEqual(viewport.width);
            const overflow = await tab.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
            await tab.click('[data-agenda-failures] button');
            expect(await tab.$('[data-agenda-failures]'), 'dismissed').toBeNull();
          } finally {
            await context.close();
          }
        }, 60_000);
});
