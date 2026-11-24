/**
 * SETTINGS › WEB SEARCH in a real browser, inside the real Settings shell (`fixtures/search-scene.tsx`).
 * Proof, on the DOM and computed geometry, at 390 and 1440 wide, light and dark: nothing sticks out sideways, every
 * control is a 44 px target, a pasted key goes to the Vault route once and is then in no DOM, storage or console line,
 * Save names the provider (never a value), Test is the person's own press, and a held setup says it is waiting.
 * Set `FY_SEARCH_SHOTS_DIR` to keep `<viewport>-<scheme>-<step>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SEARCH_SHOTS_DIR ?? '';
const FAKE_KEY = 'srp-fake-key-0123456789abcdef';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-search-settings-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/search-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the search settings scene did not build (${code}):\n${stderr}\n${stdout}`);
  const built = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(built.css, 'utf8');
  const js = await readFile(built.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

const open = async (viewport: Viewport, scheme: 'light' | 'dark', query: string) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
    colorScheme: scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const problems: string[] = [];
  const logs: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => logs.push(message.text()));
  await page.goto(`${origin}/d/ws/settings/search/search?theme=studio-${scheme}${query}`);
  await page.waitForSelector('[data-testid="search-settings"]');
  return { page, problems, logs, close: async () => await context.close() };
};

const shoot = async (page: Page, viewport: Viewport, scheme: string, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await page.setViewportSize({ width: viewport.width, height: 2_000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${name}.png`), fullPage: true });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
};

/** What is wider than the panel, and every control too small to hit: 44 px on a touch screen (the shell's rule), 28 px at a desk. */
const geometry = async (page: Page, smallest: number) =>
  await page.evaluate(least => {
    const panel = (document.querySelector('[data-testid="search-settings"]') as Element).getBoundingClientRect();
    const controls = [
      ...document.querySelectorAll(
        '[data-testid="search-settings"] input, [data-testid="search-settings"] button[type]',
      ),
    ].filter(el => (el as HTMLElement).offsetParent !== null);
    return {
      scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      past: controls
        .filter(el => el.getBoundingClientRect().right > panel.right + 1)
        .map(el => el.outerHTML.slice(0, 80)),
      short: controls
        .filter(el => el.getBoundingClientRect().height < least)
        .map(el => `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent ?? ''}`),
    };
  }, smallest);

const fakeOf = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as { __fake: unknown }).__fake)) as {
    puts: { name: string; length: number }[];
    setups: unknown[];
    tests: number;
  };

describe('Settings › Web search', () => {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`off, pick, save a key, test (${viewport.name}, ${scheme})`, async () => {
        const { page, problems, logs, close } = await open(viewport, scheme, '&state=off');
        try {
          await page.getByText('None picked: web search is off').waitFor();
          await shoot(page, viewport, scheme, '1-off');

          // Pick Serper from the list.
          await page.getByRole('combobox', { name: 'Search provider' }).click();
          await page.locator('[role="option"]', { hasText: 'Serper' }).click();
          await page.getByText('About $1 per 1,000 searches.').waitFor();
          const field = page.locator('input[type=password]');
          await field.waitFor({ state: 'visible' });
          expect(await geometry(page, viewport.phone ? 43.5 : 27.5)).toEqual({ scrollX: 0, past: [], short: [] });
          await shoot(page, viewport, scheme, '2-picked');

          await field.fill(FAKE_KEY);
          await page.getByRole('button', { name: 'Save key' }).click();
          await page.locator('[data-search-named]').waitFor({ state: 'visible' });
          const saved = await fakeOf(page);
          expect(saved.puts).toEqual([{ name: 'SERPER_API_KEY', length: FAKE_KEY.length }]);
          expect(saved.setups).toEqual([{ provider: 'serper' }]);
          const where = await page.evaluate(key => {
            const stores = [localStorage, sessionStorage].map(store => JSON.stringify({ ...store }));
            return {
              html: document.documentElement.outerHTML.includes(key),
              text: document.body.innerText.includes(key),
              stores: stores.some(store => store.includes(key)),
              value: [...document.querySelectorAll('input')].some(input => input.value.includes(key)),
            };
          }, FAKE_KEY);
          expect(where).toEqual({ html: false, text: false, stores: false, value: false });
          expect(logs.some(line => line.includes(FAKE_KEY))).toBe(false);

          // Test is the person's own press, one call.
          await page.getByRole('button', { name: 'Test' }).click();
          await page.locator('[data-search-last-test]').waitFor({ state: 'visible' });
          expect((await fakeOf(page)).tests).toBe(1);
          await page.getByText('1 of 200 searches used today').waitFor();
          expect(await geometry(page, viewport.phone ? 43.5 : 27.5)).toEqual({ scrollX: 0, past: [], short: [] });
          await shoot(page, viewport, scheme, '3-tested');
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
    }
  }

  it('a machine already set up shows the key as in use and the day’s count', async () => {
    const viewport = VIEWPORTS[1];
    const { page, close } = await open(viewport, 'light', '&state=ready');
    try {
      await page.locator('[data-search-named]').waitFor({ state: 'visible' });
      await page.getByText('37 of 200 searches used today').waitFor();
      await shoot(page, viewport, 'light', '4-ready');
    } finally {
      await close();
    }
  });

  it('raising the limit is held for the owner, and the screen says it is waiting', async () => {
    const viewport = VIEWPORTS[1];
    const { page, close } = await open(viewport, 'dark', '&state=ready&held=1');
    try {
      await page.getByLabel('Searches a day').fill('500');
      await page.getByRole('button', { name: 'Save limit' }).click();
      await page.locator('[data-search-held]').waitFor({ state: 'visible' });
      expect(await page.locator('[data-search-held]').innerText()).toContain('from 200 to 500');
      expect((await fakeOf(page)).setups).toEqual([{ dailyCap: 500 }]);
      await shoot(page, viewport, 'dark', '5-held');
    } finally {
      await close();
    }
  });
});
