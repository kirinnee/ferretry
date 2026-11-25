/**
 * ADD MCP SERVER → ADDED → RELOAD, in a real browser, over fixed fake data (no real name, path or command). After an add,
 * the owner chooses to restart now or when each ferret is idle; "now" asks first, because it interrupts a turn. Every
 * answer must stay inside the screen and be a comfortable target on a phone, in light and dark.
 *
 * Set `FY_ADD_MCP_RELOAD_SHOTS_DIR` to keep a screenshot of each state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ADD_MCP_RELOAD_SHOTS_DIR ?? '';

const FRAME_STYLES = join(packageRoot, '../../../../../core/ferrets/app/features/header/ferret-actions.css');
const SCENE_CSS = `html, body, #root { min-height: 100%; margin: 0; } #root { padding: 16px 0; }`;

const VIEWPORTS = [
  { name: '390', width: 390, height: 900, phone: true },
  { name: '1280', width: 1_280, height: 800, phone: false },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-add-mcp-reload-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/add-mcp-reload-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the add-mcp-reload scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  // The form's frame styles are Ferrets' (its header loads them for every action form), so the page carries that sheet as
  // the app does. It is read as a file, never imported: MCP reaches another package only through its contract.
  const frame = await readFile(FRAME_STYLES, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${frame}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

/** The form, filled in and added: the Added step with the reload choice. */
const added = async (context: BrowserContext, mode: 'light' | 'dark'): Promise<Page> => {
  const tab = await context.newPage();
  await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${mode}`);
  await tab.getByRole('textbox', { name: 'Name' }).fill('sentry');
  await tab.getByRole('textbox', { name: 'Command' }).fill('npx -y @example/mcp-server');
  await tab.getByRole('button', { name: 'Add server' }).click();
  await tab.waitForSelector('[data-add-mcp-when]');
  return tab;
};

const insideTheScreen = async (tab: Page, selector: string, width: number): Promise<void> => {
  const boxes = tab.locator(selector);
  for (let at = 0; at < (await boxes.count()); at += 1) {
    const box = await boxes.nth(at).boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
  }
};

describe('Add MCP server: reload now or when each ferret is idle', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`shows the choice, then the question before restarting now, at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await added(context, mode);
        expect(await tab.locator('input[value="now"]').isChecked()).toBe(true);
        await insideTheScreen(tab, '[data-add-mcp-when] .fy-choice-card, .fy-action-form__foot button', viewport.width);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}.png`), fullPage: true });
        await tab.locator('[data-add-mcp-reload]').click();
        await tab.waitForSelector('[data-add-mcp-confirm]');
        await insideTheScreen(tab, '[data-add-mcp-confirm], .fy-action-form__foot button', viewport.width);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}-confirm.png`), fullPage: true });
        await context.close();
      }, 60_000);

  it('when idle there is no question', async () => {
    const context = await newContext(VIEWPORTS[0], 'light');
    const tab = await added(context, 'light');
    await tab.locator('input[value="idle"]').check();
    if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '390-light-idle.png'), fullPage: true });
    await tab.locator('[data-add-mcp-reload]').click();
    expect(await tab.locator('[data-add-mcp-confirm]').count()).toBe(0);
    await context.close();
  }, 60_000);
});

describe('Add MCP server: the login preview speaks in names (L231a)', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`names the runtime and the profile, not their ids, at ${viewport.name}, ${mode}`, async () => {
        const context = await newContext(viewport, mode);
        const tab = await context.newPage();
        await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${mode}`);
        await tab.getByRole('textbox', { name: 'Name' }).fill('sentry');
        await tab.getByRole('textbox', { name: 'Command' }).fill('npx -y @example/mcp-server');
        await tab.waitForSelector('[data-add-mcp-preview="login"]');
        await tab.waitForTimeout(300);
        const preview = (await tab.locator('[data-add-mcp-preview="login"]').innerText()).replaceAll('\n', ' ');
        expect(preview).toContain('Your Claude setup');
        expect(preview).toContain('Claude · your terminal sign-in');
        expect(preview).not.toContain('claude-default');
        expect(preview).not.toContain('claude-you');
        await insideTheScreen(tab, '[data-add-mcp-preview="login"]', viewport.width);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}-preview.png`), fullPage: true });
        await context.close();
      }, 60_000);
});
