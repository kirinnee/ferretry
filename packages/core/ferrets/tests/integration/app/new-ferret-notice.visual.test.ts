/**
 * E-266 in a real browser, Ferrets' half: a start the daemon answers with "Started without Fast: …" does not leave the
 * New ferret page at once. The one plain line is shown where the person pressed Create, "Open ferret" goes on to the
 * chat, and the Create form is gone so the start cannot be sent twice.
 *
 * Fake daemon, no network (`fixtures/new-ferret-notice-scene.tsx`). Set `FY_E266_SHOTS_DIR` to keep PNGs.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_E266_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-new-ferret-notice-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/new-ferret-notice-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
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

// `studio` is the default rounding; `afterglow` is Neumorphism, the highest (pill controls, 24px panels).
const VARIANTS = [
  { name: '1440-light-default', width: 1_440, height: 900, phone: false, theme: 'studio-light', scheme: 'light' },
  { name: '1440-dark-default', width: 1_440, height: 900, phone: false, theme: 'studio-dark', scheme: 'dark' },
  { name: '1440-light-round', width: 1_440, height: 900, phone: false, theme: 'afterglow-light', scheme: 'light' },
  { name: '1440-dark-round', width: 1_440, height: 900, phone: false, theme: 'afterglow-dark', scheme: 'dark' },
  { name: '390-light-default', width: 390, height: 844, phone: true, theme: 'studio-light', scheme: 'light' },
  { name: '390-dark-default', width: 390, height: 844, phone: true, theme: 'studio-dark', scheme: 'dark' },
  { name: '390-light-round', width: 390, height: 844, phone: true, theme: 'afterglow-light', scheme: 'light' },
  { name: '390-dark-round', width: 390, height: 844, phone: true, theme: 'afterglow-dark', scheme: 'dark' },
] as const;

const NOTICE = '[data-new-ferret-notice]';

const withTab = async (
  variant: (typeof VARIANTS)[number],
  run: (tab: Page) => Promise<void>,
  scene?: string,
): Promise<void> => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    colorScheme: variant.scheme,
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  try {
    await tab.goto(`${origin}/?theme=${variant.theme}${scene === undefined ? '' : `&scene=${scene}`}`);
    await tab.waitForSelector(scene === undefined ? '#fy-new-ferret-prompt' : '[data-scene-ready]');
    await tab.waitForTimeout(300);
    await run(tab);
  } finally {
    await context.close();
  }
};

describe('New ferret when the start went on without Fast', () => {
  for (const variant of VARIANTS)
    it(`${variant.name}: one plain line says so, Open ferret goes on, and nothing leaves by itself`, () =>
      withTab(variant, async tab => {
        await tab.fill('#fy-new-ferret-runtime', 'codex-auto');
        await tab.fill('#fy-new-ferret-folder', '/work/ferretry');
        await tab.fill('#fy-new-ferret-prompt', 'Port the page');
        await tab.getByRole('button', { name: 'Create ferret' }).click();
        await tab.waitForSelector(NOTICE);
        await tab.waitForTimeout(200);

        expect(await tab.textContent(NOTICE)).toContain('Started without Fast: Codex’s model list is still loading');
        expect(await tab.getByRole('button', { name: 'Create ferret' }).count()).toBe(0);
        expect(await tab.evaluate(() => (window as unknown as { __navigated: string[] }).__navigated)).toEqual([]);
        // No horizontal scroll at any width: the line wraps instead.
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTrue();
        // The page scrolls inside its own column: bring the footer into the frame before the shot.
        await tab.locator(NOTICE).scrollIntoViewIfNeeded();
        await tab.getByRole('button', { name: 'Open ferret' }).scrollIntoViewIfNeeded();
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}.png`) });

        await tab.getByRole('button', { name: 'Open ferret' }).click();
        expect(await tab.evaluate(() => (window as unknown as { __navigated: string[] }).__navigated)).toEqual([
          '/d/fake/ferrets/new-ferret/chat',
        ]);
      }));
});

for (const scene of ['resume', 'restart', 'toolbar'])
  for (const variant of VARIANTS)
    it(`E-266 R2 ${scene} ${variant.name}: the actual action shows the daemon's downgrade`, () =>
      withTab(
        variant,
        async tab => {
          await tab.getByRole('button', { name: scene === 'restart' ? 'Restart' : 'Resume', exact: true }).click();
          const toast = tab.locator('[data-action-toast]');
          await toast.getByRole('status').filter({ hasText: 'Started without Fast:' }).waitFor();
          expect(await toast.textContent()).toContain('Started without Fast: Codex’s model list is still loading');
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTrue();
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${scene}-${variant.name}.png`) });
          await tab.getByRole('button', { name: 'Dismiss', exact: true }).click();
          expect(await toast.textContent()).not.toContain('Started without Fast:');
        },
        scene,
      ));
