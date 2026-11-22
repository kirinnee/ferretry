/**
 * O8-9 in a real browser: a ready login is a runtime, and the builder is a short "Advanced" form.
 *
 * The scene (`fixtures/simple-runtimes-scene.tsx`) is the REAL New ferret page with the REAL picker over a fake daemon
 * that has FOUR ready Claude logins and no runtime anybody made, and the REAL Advanced form. At a phone and a desktop,
 * light and dark:
 *
 *  - the runtime field New ferret draws lists one runtime per ready login (open list: four rows under Claude), one already
 *    chosen, and shows no "no runtime" notice;
 *  - the Advanced form is Login, Profile (with the model it starts on) and Name, with Create, nothing wider than the window;
 * *
 * Set `FY_O89_SHOTS_DIR` to keep `<window>-<mode>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_O89_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-simple-runtimes-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/simple-runtimes-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
  const built = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const [css, js] = [await readFile(built.css, 'utf8'), await readFile(built.js, 'utf8')];
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const WINDOWS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const openScene = async (size: (typeof WINDOWS)[number], mode: 'light' | 'dark', query: string) => {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    colorScheme: mode,
    deviceScaleFactor: size.phone ? 2 : 1,
    ...(size.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  await tab.goto(`${origin}/?theme=studio-${mode}&${query}`);
  await tab.waitForSelector('[data-scene-ready]');
  return { tab, close: async () => await context.close() };
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
};

const noSideways = async (tab: Page): Promise<void> => {
  const widths = await tab.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    window: window.innerWidth,
  }));
  expect(widths.scroll, 'nothing wider than the window').toBeLessThanOrEqual(widths.window);
};

for (const mode of ['light', 'dark'] as const)
  describe(`one runtime per ready login (${mode})`, () => {
    for (const size of WINDOWS) {
      it(`at ${size.name}: New ferret has a runtime chosen already, from four ready logins, and no empty notice`, async () => {
        const { tab, close } = await openScene(size, mode, 'view=new&logins=4');
        try {
          await tab.waitForSelector('[data-chosen-runtime]');
          await tab.waitForTimeout(500);
          expect(await tab.locator('[data-new-ferret-no-accounts]').count()).toBe(0);
          expect(await tab.locator('[data-chosen-runtime]').textContent()).toBe('Chosen: atomi');
          await shot(tab, `${size.name}-${mode}-new-ferret`);
          await tab.locator('[aria-labelledby="fy-new-ferret-runtime-label"], #fy-new-ferret-runtime').first().click();
          await tab.waitForTimeout(300);
          await shot(tab, `${size.name}-${mode}-new-ferret-list-open`);
          const text = (await tab.locator('body').textContent()) ?? '';
          for (const name of ['atomi', 'llm1', 'llm2', 'personal']) expect(text).toContain(name);
          await noSideways(tab);
        } finally {
          await close();
        }
      });

      it(`at ${size.name}: the Advanced form is Login, Profile and Name, short, with Create`, async () => {
        const { tab, close } = await openScene(size, mode, 'view=advanced&logins=4');
        try {
          await tab.waitForSelector('#add-runtime-name');
          await shot(tab, `${size.name}-${mode}-advanced`);
          expect(await tab.locator('[data-add-runtime-part]').count()).toBe(3);
          expect(await tab.locator('[data-add-runtime-more]').count()).toBe(0);
          expect(await tab.locator('[data-change-submit]').count()).toBeGreaterThan(0);
          await noSideways(tab);
        } finally {
          await close();
        }
      });
    }
  });
