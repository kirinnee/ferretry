/**
 * "Seen by" on Settings › MCP servers, in a real browser over fake data (Q8a): every runtime is named in words
 * (`Claude · your terminal sign-in`), never by its stored name (`claude-work`), at a phone and a desktop, light and dark.
 *
 * Set `FY_MCP_SEEN_BY_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_MCP_SEEN_BY_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-mcp-seen-by-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/mcp-seen-by-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the MCP scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '390', width: 390, height: 900, phone: true },
] as const;

describe('Settings › MCP servers: "Seen by" names runtimes in words (Q8a)', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of ['studio-light', 'studio-dark'] as const) {
      it(`says the login, not the stored name (${viewport.name}, ${theme})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        try {
          await tab.goto(`${origin}/?theme=${theme}`);
          await tab.locator('[data-mcp-details="notion"]').waitFor({ state: 'visible' });
          await tab.waitForTimeout(400);
          const notion = (await tab.locator('[data-mcp-details="notion"]').innerText()).replaceAll('\n', ' ');
          expect(notion).toContain('Claude · your terminal sign-in (approved)');
          expect(await tab.locator('[data-settings="mcp"]').innerText()).not.toContain('claude-work');
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-seen-by.png`) });
        } finally {
          await context.close();
        }
      });
    }
  }
});

/** The tab on one fake inventory, at one size and theme; hands the page to `check`, then keeps the picture. */
const withScene = async (
  viewport: (typeof VIEWPORTS)[number],
  theme: 'studio-light' | 'studio-dark',
  data: 'healthy' | 'builtins',
  name: string,
  check: (tab: Awaited<ReturnType<Browser['newPage']>>) => Promise<void>,
): Promise<void> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  try {
    await tab.goto(`${origin}/?theme=${theme}&data=${data}`);
    await tab.locator('[data-scene-ready]').waitFor({ state: 'visible' });
    await tab.waitForTimeout(400);
    await check(tab);
    expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-${name}.png`) });
  } finally {
    await context.close();
  }
};

describe('Settings › MCP servers: the Needs attention chip with nothing to attend to (E204)', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of ['studio-light', 'studio-dark'] as const)
      it(`says no server needs attention, not that there is no server (${viewport.name}, ${theme})`, async () => {
        await withScene(viewport, theme, 'healthy', 'needs-attention-empty', async tab => {
          await tab.getByRole('button', { name: /Needs attention/u }).click();
          const note = await tab.locator('[data-context-note]').innerText();
          expect(note).toBe('No servers need attention.');
          expect(await tab.locator('[data-settings="mcp"]').innerText()).not.toContain('No runtime on this machine');
        });
      });
});

describe('Settings › MCP servers: two built-in servers named ferretry (L278)', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of ['studio-light', 'studio-dark'] as const)
      it(`names the harness on each row (${viewport.name}, ${theme})`, async () => {
        await withScene(viewport, theme, 'builtins', 'builtins', async tab => {
          const titles = await tab.locator('[data-mcp-row] [data-mcp-title]').allInnerTexts();
          expect(titles.map(title => title.replaceAll('\n', ' ').trim()).sort()).toEqual([
            'ferretry · Claude',
            'ferretry · Codex',
          ]);
        });
      });
});
