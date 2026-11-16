/**
 * THE FERRET LIST'S "RESTART OUTDATED" AND THE INSTRUCTIONS PANEL, in a real browser over fake data
 * (`fixtures/shell-gaps-scene.tsx`): the outdated mark on a row, the ⋯ with its count badge and its menu, the answer line,
 * and the Instructions list. Set `FY_SHELL_GAPS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type Page = Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['newPage']>>;

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SHELL_GAPS_SHOTS_DIR ?? '';

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-shell-gaps-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/shell-gaps-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const open = async (variant: (typeof VARIANTS)[number], view: string, ready: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?view=${view}&theme=studio-${variant.scheme}`);
  try {
    await tab.waitForSelector(ready, { timeout: 8_000 });
  } catch (error) {
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: (typeof VARIANTS)[number], name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

describe('the ferret list with outdated ferrets', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: two marks, a badge on the ⋯, and the menu's Restart outdated (2)`, async () => {
      const { tab, close } = await open(variant, 'list', '[data-sbar-session]');
      try {
        expect(await tab.locator('.fy-outdated-mark').count()).toBe(2);
        await shot(tab, variant, 'ferret-list-outdated');
        await tab.locator('[data-sbar-options]').click();
        await tab.waitForSelector('[data-context-menu] [role="menuitem"]');
        expect(await tab.locator('[data-context-menu] [role="menuitem"]').first().textContent()).toContain(
          'Restart outdated (2)',
        );
        const box = await tab.locator('[data-context-menu]').boundingBox();
        expect(box === null || box.x >= 0).toBe(true);
        await shot(tab, variant, 'ferret-list-menu');
        await tab.locator('[data-context-menu] [role="menuitem"]').first().click();
      } finally {
        await close();
      }
    });
    it(`${variant.name}: after the press the answer line says restarted and queued, and the marks follow`, async () => {
      const { tab, close } = await open(variant, 'list-answered', '[data-sbar-options]');
      try {
        await tab.locator('[data-sbar-options]').click();
        await tab.locator('[data-context-menu] [role="menuitem"]').first().click();
        await tab.waitForSelector('[data-restart-outdated-result]');
        expect(await tab.locator('[data-restart-outdated-result]').textContent()).toContain(
          '1 ferret restarted now, 1 ferret queued for their next idle moment.',
        );
        expect(await tab.locator('[data-outdated-mark="queued"]').count()).toBe(1);
        expect(await tab.locator('.fy-outdated-mark').count()).toBe(1);
        await shot(tab, variant, 'ferret-list-answered');
      } finally {
        await close();
      }
    });
  }
});

describe('the Instructions panel', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: the folder's instruction files, with search and chips`, async () => {
      const { tab, close } = await open(variant, 'instructions', '[data-context-doc]');
      try {
        expect(await tab.locator('[data-context-doc]').count()).toBe(4);
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, 'no horizontal overflow').toBe(false);
        await shot(tab, variant, 'instructions');
      } finally {
        await close();
      }
    });
  }
});
