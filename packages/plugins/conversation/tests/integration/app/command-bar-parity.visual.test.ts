/**
 * L253: Ctrl+K's work search follows what is installed, in a real browser: the REAL `CommandBar` with Conversation's work
 * source. With the Board and the Agenda both on it offers the Tasks/Agenda chip and lists tasks and asks; with one off it
 * offers no chip to choose by and lists only the kind that can be opened; with both off it has no chips and no rows.
 * Chips and rows agree. Set `FY_COMMAND_BAR_PARITY_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_COMMAND_BAR_PARITY_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-bar-parity-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/command-bar-parity-scene.tsx'],
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

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const CASES = [
  { name: 'both-on', query: '', chips: ['All', 'Tasks', 'Agenda', 'Everything', 'Open'], rows: ['F10', 'A3'] },
  { name: 'agenda-off', query: '&agenda=0', chips: ['Everything', 'Open'], rows: ['F10'] },
  { name: 'board-off', query: '&board=0', chips: ['Everything', 'Open'], rows: ['A3'] },
  { name: 'both-off', query: '&board=0&agenda=0', chips: [], rows: [] },
] as const;

const withBar = async (
  viewport: (typeof VIEWPORTS)[number],
  scheme: 'light' | 'dark',
  query: string,
  run: (tab: Page) => Promise<void>,
): Promise<void> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
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
    await tab.goto(`${origin}/?theme=studio-${scheme}${query}`);
    await tab.waitForSelector('#fy-command-bar-input', { timeout: 15_000 });
    await run(tab);
  } finally {
    await context.close();
  }
};

describe('Ctrl+K work search follows Board and Agenda', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const scene of CASES)
        it(`${viewport.name} ${scheme}: ${scene.name}: chips and rows agree`, () =>
          withBar(viewport, scheme, scene.query, async tab => {
            await tab.locator('#fy-command-bar-input').fill('relay');
            // The source answers within its pause; when there are rows, wait for them, else give the pause time to pass.
            if (scene.rows.length > 0) await tab.waitForSelector('[role="option"]');
            else await tab.waitForTimeout(400);
            const seen = await tab.evaluate(() => ({
              chips: [...document.querySelectorAll('[data-command-bar-filters] button')].map(b => b.textContent),
              rows: [...document.querySelectorAll('[role="option"]')].map(o => (o as HTMLElement).innerText),
              asked: (window as unknown as { __asked: { query?: { kind?: string } }[] }).__asked.map(
                a => a.query?.kind,
              ),
            }));
            expect(seen.chips, 'the chips').toEqual([...scene.chips]);
            expect(seen.rows.length, 'the rows').toBe(scene.rows.length);
            for (const [index, id] of scene.rows.entries()) expect(seen.rows[index]).toContain(id);
            if (scene.name === 'both-off') expect(seen.asked, 'nothing was searched').toEqual([]);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${scene.name}.png`) });
          }));
});
