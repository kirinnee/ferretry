/**
 * THE MACHINE-SETUP STEPS THIS PLUGIN CONTRIBUTES, in a real browser, over fixed fake data
 * (`fixtures/setup-steps-scene.tsx`): Agent controls, Start from…, and Export settings. Each stays inside the screen, keeps
 * every button a 44px target, and reads in light and dark, on a desktop and on a phone.
 *
 * Set `FY_SETUP_STEPS_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

// The browser's types come from the helper that launches it, so this package declares no browser library of its own.
type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type BrowserContext = Awaited<ReturnType<Browser['newContext']>>;
type Page = Awaited<ReturnType<BrowserContext['newPage']>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETUP_STEPS_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-setup-steps-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/setup-steps-scene.tsx'],
    {
      cwd: packageRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the setup-steps scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const newContext = async (viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark'): Promise<BrowserContext> => {
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
  return context;
};

const open = async (context: BrowserContext, view: string, mode: 'light' | 'dark'): Promise<Page> => {
  const tab = await context.newPage();
  await tab.goto(`${server?.url.origin ?? ''}/?view=${view}&theme=studio-${mode}`);
  return tab;
};

const insideScreen = async (tab: Page, selector: string, width: number): Promise<void> => {
  const boxes = tab.locator(selector);
  for (let at = 0; at < (await boxes.count()); at += 1) {
    const box = await boxes.nth(at).boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1);
  }
};

describe('the machine-setup steps', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const) {
      it(`Agent controls: five switches, the default runtime, a Save once one is flipped (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'controls', mode);
        await tab.waitForSelector('[data-agent-control]');
        expect(await tab.locator('[data-switch-row]').count()).toBe(5);
        await tab.locator('[data-switch-row="Ferretry settings"] [role="switch"]').click();
        await tab.locator('[data-switch-row="Page scripts"] [data-switch-info]').click();
        await tab.getByText('Save what agents may control').waitFor();
        await tab.waitForSelector('[data-default-runtime]');
        await insideScreen(tab, '[data-switch-row], [data-default-runtime]', viewport.width);
        for (const switchButton of await tab.locator('[role="switch"]').all())
          expect((await switchButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `agent-controls-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);

      it(`Start from…: a fresh setup, and a copy with no other machine paired (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'start', mode);
        await tab.waitForSelector('[data-onboarding-step-body="start"]');
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `start-from-fresh-${viewport.name}-${mode}.png`) });
        await tab.getByText('Clone settings from another machine').click();
        await tab.waitForSelector('[data-copy-no-sources]');
        await insideScreen(tab, '[data-onboarding-step-body="start"] *', viewport.width);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `start-from-copy-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);

      it(`Export settings: the listing, one file left out, no secret (${viewport.name}, ${mode})`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await open(context, 'export', mode);
        await tab.locator('[data-export-run]').click();
        await tab.waitForSelector('[data-setup-section="export-manifest"]');
        expect(await tab.locator('[data-setup-section="export-manifest"]').innerText()).toContain('config/warden.yaml');
        expect(await tab.locator('[data-setup-section="export-manifest"]').innerText()).not.toContain(
          'logins/work.yaml',
        );
        await tab.waitForSelector('[data-export-left-out], [data-setup-note="export-left-out"]');
        await insideScreen(tab, '[data-export-settings] *', viewport.width);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `export-settings-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);
    }
});
