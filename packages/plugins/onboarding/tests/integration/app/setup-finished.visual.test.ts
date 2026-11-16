/**
 * THE STEPS SCREEN'S CLOSING SUMMARY, in a real browser, over fixed fake data (`fixtures/setup-finished-scene.tsx`):
 * once no step waits, it says what was set up and links each step left for later or skipped to its Settings; while a
 * step still waits there is no summary. Light and dark, on a desktop and on a phone, never wider than the screen.
 *
 * Set `FY_SETUP_FINISHED_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETUP_FINISHED_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-setup-finished-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/setup-finished-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the setup-finished scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

describe('the steps screen’s closing summary', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const) {
      it(`says what was set up and links what was left for later (${viewport.name}, ${mode})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: mode,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        await tab.goto(`${origin}/?view=finished&theme=studio-${mode}`);
        await tab.waitForSelector('[data-onboarding-summary]');
        const set = await tab.locator('[data-onboarding-summary-set]').innerText();
        expect(set).toContain('Start from');
        expect(set).not.toContain('…');
        expect(set).toContain('Sign in');
        expect(await tab.locator('[data-onboarding-later-link]').count()).toBe(3);
        expect(await tab.locator('[data-onboarding-later-link="voice.voice"]').getAttribute('href')).toBe(
          '/d/studio-mac/settings/voice',
        );
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        for (const link of await tab.locator('[data-onboarding-later-link]').all())
          expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(43);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `setup-finished-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);
    }

  it('shows no summary while a step still waits', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const origin = server?.url.origin ?? '';
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
    );
    const tab = await context.newPage();
    await tab.goto(`${origin}/?view=waiting&theme=studio-light`);
    await tab.waitForSelector('[data-scene="ready"]');
    expect(await tab.locator('[data-onboarding-summary]').count()).toBe(0);
    await context.close();
  }, 60_000);
});
