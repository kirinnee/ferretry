/**
 * What every Browsers visual test shares: a scene built in a CHILD process (`sceneBuilder`, never in-process) and served
 * from a static server, and a context that can reach nothing but that server. A test opens its own contexts from it, so
 * cases share no state.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder } from '@ferretry/app/testing/browser';
import type { Browser, BrowserContext, Page } from 'playwright-core';

export interface ServedScene {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

/** Builds `entry` (relative to `cwd`, the test's own directory) and serves it at `/` with its script at `/app.js`. */
export const serveScene = async (cwd: string, entry: string, name: string): Promise<ServedScene> => {
  const directory = await mkdtemp(join(tmpdir(), `ferretry-${name}-`));
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', entry], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    await rm(directory, { force: true, recursive: true });
    throw new Error(`the ${name} scene did not build (${code}):\n${stderr}\n${stdout}`);
  }
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{height:100%;margin:0}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.FY_BROWSER_SCENE_PORT ?? '0'),
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  return {
    origin: server.url.origin,
    stop: async () => {
      server.stop(true);
      await rm(directory, { force: true, recursive: true });
    },
  };
};

export const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
] as const;
export const THEMES = ['light', 'dark'] as const;
export type Viewport = (typeof VIEWPORTS)[number];
export type Theme = (typeof THEMES)[number];

export interface SettingsCase {
  readonly origin: string;
  readonly scene: string;
  readonly viewport: Viewport;
  readonly theme: Theme;
  /** Selectors that must be on screen, and what must hold of the page before it is shot. */
  readonly visible: readonly string[];
  readonly inspect?: (page: Page) => Promise<void>;
  /** Where the shot goes (never when empty) and what to call it. */
  readonly shotsDir: string;
  readonly name: string;
}

/**
 * One settings scene at one viewport and theme: nothing scrolls sideways, every `visible` selector is drawn, and the
 * page is shot at its full height. Returns the page's overflow so a test can assert it.
 */
export const checkSettingsScene = async (browser: Browser, one: SettingsCase): Promise<number> => {
  const context = await sceneContext(browser, one.origin, one.viewport, one.theme);
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(error.message));
    await page.goto(`${one.origin}/?theme=studio-${one.theme}&scene=${one.scene}`);
    try {
      for (const selector of one.visible) await page.waitForSelector(selector, { state: 'visible' });
    } catch (error) {
      throw new Error(`the ${one.scene} scene did not draw: ${String(error)}\n${problems.join('\n')}`);
    }
    await one.inspect?.(page);
    const overflow = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
    // The app stylesheet clips the document to the viewport, so the viewport grows to the content.
    const height = await page.evaluate<number>("document.querySelector('[data-scene]').scrollHeight");
    await page.setViewportSize({ width: one.viewport.width, height: Math.max(one.viewport.height, height) });
    if (one.shotsDir !== '')
      await page.screenshot({
        animations: 'disabled',
        path: join(one.shotsDir, `${one.name}-${one.viewport.name}-${one.theme}.png`),
      });
    return overflow as number;
  } finally {
    await context.close();
  }
};

/** A context at one viewport and theme that aborts every request to any origin but the scene's own. */
export const sceneContext = async (
  browser: Browser,
  origin: string,
  viewport: { readonly width: number; readonly height: number },
  theme: Theme,
): Promise<BrowserContext> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme,
    reducedMotion: 'reduce',
    deviceScaleFactor: 2,
  });
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};
