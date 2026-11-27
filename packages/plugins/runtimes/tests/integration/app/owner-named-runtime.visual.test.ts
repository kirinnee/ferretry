/**
 * E-296 in a real browser: the REAL Settings › Runtimes list over a scripted machine where one runtime was named by an
 * import (`claude-default`) and one was typed by the owner (`claude-work`). The imported name reads in words; the owner's
 * name stays as typed. At a phone and a desktop, light and dark, in the default look (Studio) and in the two highest-rounding
 * looks (Gen Z, Neumorphism), with nothing wider than the window.
 *
 * Set `FY_E296_SHOTS_DIR` to keep `<window>-<look>-<mode>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_E296_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-owner-named-runtime-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/owner-named-runtime-scene.tsx'],
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
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const LOOKS = [
  { name: 'studio', style: 'studio', palette: 'studio' },
  { name: 'genz', style: 'genz', palette: 'vaporwave' },
  { name: 'neumorphism', style: 'neumorphism', palette: 'afterglow' },
] as const;

for (const look of LOOKS)
  for (const mode of ['light', 'dark'] as const)
    describe(`an owner-named runtime keeps its name (${look.name}, ${mode})`, () => {
      for (const size of WINDOWS) {
        it(`at ${size.name}: claude-work stays as typed beside a runtime an import named`, async () => {
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
          try {
            await tab.goto(`${origin}/?style=${look.style}&palette=${look.palette}&mode=${mode}`);
            await tab.waitForSelector('[data-runtime-row="claude-work"]');
            await tab.waitForTimeout(400);
            // The look really is the one asked for: nothing on the page swapped it back to the default.
            expect(await tab.evaluate(() => document.documentElement.dataset.style)).toBe(look.style);
            const owned = (await tab.locator('[data-runtime-card="claude-work"]').textContent()) ?? '';
            const made = (await tab.locator('[data-runtime-card="claude-default"]').textContent()) ?? '';
            expect(owned).toContain('claude-work');
            expect(owned).not.toContain('Claude · your terminal sign-in');
            expect(made).toContain('Claude · your terminal sign-in');
            expect(made).not.toContain('claude-default');
            const widths = await tab.evaluate(() => ({
              scroll: document.documentElement.scrollWidth,
              window: window.innerWidth,
            }));
            expect(widths.scroll, 'nothing wider than the window').toBeLessThanOrEqual(widths.window);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${size.name}-${look.name}-${mode}.png`), fullPage: true });
          } finally {
            await context.close();
          }
        });
      }
    });
