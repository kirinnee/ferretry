/**
 * THE AGENDA TAB AND THE INBOX OF A MIXED FLEET, in a real browser, on a phone (390) and a desktop (1440).
 *
 * - The tab: each filter lists its own rows with the stage the item is at (a closed item shows the last stage it had,
 *   never "Done / Done"). The Info panel's tab strip and Overview line are Ferrets', not drawn here.
 * - Row opening: a row is a button that hands its item to the shell.
 * - The Inbox: a card's ask is an agenda item, so there is no To test section, no To test rows in "Answer quickly" and no
 *   snoozed to-test row. (The older machine that kept all three is gone from the product.)
 *
 * Set `FY_AGENDA_TAB_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

/** This file's folder: the scene paths below are relative to it, and the builder runs here. */
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_AGENDA_TAB_SHOTS_DIR ?? '';

let browser: Browser;
const directories: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;
const scenes = new Map<string, string>();

const build = async (entry: string): Promise<{ readonly css: string; readonly js: string }> => {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-agenda-tab-'));
  directories.push(directory);
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', entry], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${entry} did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

const pageOf = (css: string, script: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="${script}"></script></body></html>`;

beforeAll(async () => {
  browser = await sharedChromium();
  const tab = await build('fixtures/agenda-tab-scene.tsx');
  const inbox = await build('fixtures/inbox-card-asks-scene.tsx');
  scenes.set('/tab', pageOf(tab.css, '/tab.js'));
  scenes.set('/inbox', pageOf(inbox.css, '/inbox.js'));
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/tab.js') return new Response(tab.js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/inbox.js') return new Response(inbox.js, { headers: { 'content-type': 'text/javascript' } });
      const html = scenes.get(path);
      return html === undefined
        ? new Response('not here', { status: 404 })
        : new Response(html, { headers: { 'content-type': 'text/html' } });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  for (const directory of directories) await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1440', width: 1_440, height: 900, phone: false },
] as const;

const open = async (path: string, viewport: (typeof VIEWPORTS)[number], scheme: 'light' | 'dark') => {
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
  const page = await context.newPage();
  await page.goto(`${origin}${path}${path.includes('?') ? '&' : '?'}theme=studio-${scheme}`);
  return { context, page };
};

const texts = async (page: Page, selector: string): Promise<string[]> =>
  await page.$$eval(selector, nodes => nodes.map(node => (node.textContent ?? '').trim()));

const noSidewaysScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
};

describe('The Agenda tab', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`lists its rows by filter and opens a row (${viewport.name}, ${scheme})`, async () => {
        const { context, page } = await open('/tab', viewport, scheme);
        try {
          await page.waitForSelector('[data-agenda-tab="needs-you"]', { timeout: 15_000 });
          expect(await texts(page, '[data-agenda-tab-row] [data-agenda-tab-stage]')).toEqual([
            'Plan to approve',
            'Test',
          ]);

          await page.click('[data-context-chip="resolved"]');
          await page.waitForSelector('[data-agenda-tab="resolved"]');
          expect((await texts(page, '[data-agenda-tab-row] [data-agenda-tab-stage]')).sort()).toEqual([
            'Plan to approve',
            'Test',
          ]);
          expect(await texts(page, '[data-agenda-tab-row] [data-agenda-tab-state]')).toEqual(['Done', 'Done']);
          if (shotsDir !== '')
            await page.screenshot({ path: join(shotsDir, `agenda-resolved-${viewport.name}-${scheme}.png`) });

          await page.click('[data-context-chip="needs-you"]');
          await page.click('[data-agenda-tab-row] >> nth=1');
          expect(await page.textContent('[data-opened]')).toBe('A2');
          await noSidewaysScroll(page);
        } finally {
          await context.close();
        }
      }, 60_000);
});

describe('The Inbox', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`has no To test list: a card's ask is an agenda item (${viewport.name}, ${scheme})`, async () => {
        const { context, page } = await open('/inbox', viewport, scheme);
        try {
          await page.waitForSelector('[data-agenda-filter]', { timeout: 15_000 });
          await page.waitForSelector('[data-agenda-quick]');
          const quick = Number(await page.textContent('[data-agenda-quick] .fy-inbox-quick__count'));
          expect(await page.locator('[data-agenda-section="to-test"]').count(), 'To test section').toBe(0);
          expect(await page.locator('[data-to-test]').count(), 'To test rows').toBe(0);
          expect(quick, 'the quick run').toBe(1);

          await page.click('[data-agenda-filter] [aria-haspopup="menu"]');
          await page.click('[data-agenda-filter-option="snoozed"]');
          await page.waitForTimeout(300);
          expect(await page.locator('[data-to-test-snoozed]').count(), 'snoozed to-test rows').toBe(0);
          await noSidewaysScroll(page);
          if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `inbox-${viewport.name}-${scheme}.png`) });
        } finally {
          await context.close();
        }
      }, 90_000);
});
