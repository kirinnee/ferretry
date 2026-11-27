/**
 * AN ANSWER IN ITS UNDO WINDOW SHOWS IN THE ITEM'S CONVERSATION AT ONCE, in a real browser, at 390 and 1440, light and dark,
 * at the default and the highest rounding: answering draws the owner's line ("Saved on this device"), Undo takes it
 * out again, and when the window closes it stays while the answer is sent. Fake data only.
 *
 * Set `FY_PENDING_ANSWER_SHOTS_DIR` to keep `<viewport>-<scheme>-<rounding>-<step>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PENDING_ANSWER_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
`;

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
  'bubble-radius',
  'card-radius',
  'menu-radius',
  'md-code-radius',
  'md-quote-radius',
  'md-link-radius',
  'md-stack-radius',
];

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pending-answer-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pending-answer-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the pending-answer scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
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

const owned = (tab: Page): Promise<string[]> =>
  tab.evaluate(() =>
    [...document.querySelectorAll('[data-agenda-history] [data-history="owner"]')].map(
      row =>
        `${row.querySelector('.fy-hist__said')?.textContent ?? ''}|${row.querySelector('[data-send-receipt]')?.getAttribute('data-send-receipt') ?? ''}`,
    ),
  );

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;

describe('an answer in its undo window, in the item conversation', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const rounding of ['default', 'highest'] as const)
        it(`draws at once, leaves with Undo, stays while sent (${viewport.name}, ${scheme}, ${rounding})`, async () => {
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
          const tab = await context.newPage();
          const shoot = async (step: string): Promise<void> => {
            await tab.evaluate(() =>
              document.querySelector('[data-agenda-history]')?.scrollIntoView({ block: 'center' }),
            );
            await tab.evaluate(
              () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
            );
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${rounding}-${step}.png`) });
          };
          try {
            await tab.goto(`${origin}/?theme=studio-${scheme}`);
            await tab.waitForSelector('[data-agenda-fold="conversation"]');
            if (rounding === 'highest')
              await tab.evaluate(names => {
                for (const name of names)
                  document.documentElement.style.setProperty(`--${name}`, 'var(--radius-round)');
              }, RADII);
            await tab.evaluate(async () => document.fonts.ready);
            await tab.click('[data-agenda-fold="conversation"]');
            expect(await owned(tab), 'nothing said yet').toEqual([]);

            await tab.click('[data-scene-answer]');
            expect(await owned(tab), 'the answer is in the conversation at once').toEqual(['Ship|saved']);
            await shoot('held');

            await tab.click('[data-scene-undo]');
            expect(await owned(tab), 'Undo takes it out again').toEqual([]);

            await tab.click('[data-scene-answer]');
            await tab.click('[data-scene-flush]');
            expect(await owned(tab), 'it stays while it is being sent').toEqual(['Ship|saved']);
            const overflow = await tab.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
            await shoot('sending');
          } finally {
            await context.close();
          }
        }, 60_000);
});
