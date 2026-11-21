/**
 * PR 2288's review fixes in a real browser, over FAKE data: the GitHub accounts section of a project's page.
 *
 *   1. a project with NO links still shows the passkey press, and pressing it unlocks "Link an account";
 *   3. a removed default shows in the editor with its warning, and "Make default" on another account clears it.
 *
 * Set `FY_ACCOUNT_LINKS_SHOTS_DIR` to keep `<viewport>-<scheme>-<shot>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ACCOUNT_LINKS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-account-links-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/account-links-scene.tsx'],
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
type Viewport = (typeof VIEWPORTS)[number];

const withTab = async (
  viewport: Viewport,
  scheme: 'light' | 'dark',
  query: string,
  run: (tab: Page, shot: (name: string) => Promise<void>) => Promise<void>,
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
  const shot = async (name: string): Promise<void> => {
    if (shotsDir === '') return;
    // The section is the subject; scroll it into view so the phone shot is not the page's top.
    await tab.locator('section[aria-label="GitHub accounts"]').scrollIntoViewIfNeeded();
    await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${name}.png`), fullPage: true });
  };
  try {
    await tab.goto(`${origin}/?theme=studio-${scheme}&${query}`);
    await tab.waitForSelector('[data-scene-ready] h1', { timeout: 15_000 });
    await tab.waitForTimeout(250);
    await run(tab, shot);
  } finally {
    await context.close();
  }
};

const inside = (tab: Page, selector: string) =>
  tab.evaluate(sel => {
    const section = document.querySelector('section[aria-label="GitHub accounts"]')?.getBoundingClientRect();
    return [...document.querySelectorAll(sel)].map(el => {
      const box = el.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        left: box.left,
        right: box.right,
        sectionLeft: section?.left ?? 0,
        sectionRight: section?.right ?? 0,
        viewport: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
  }, selector);

describe('a project page’s GitHub accounts', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`keeps the passkey press on a project with no links, and it unlocks the link control (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, 'case=none-stepup', async (tab, shot) => {
          await tab.waitForSelector('[data-confirm-to-see]');
          expect(await tab.locator('[data-project-accounts="none"]').count(), 'the empty line is still said').toBe(1);
          expect(await tab.locator('[data-project-accounts-edit]').count(), 'no editor before the press').toBe(0);
          const press = (await inside(tab, '[data-confirm-to-see] button'))[0];
          console.info(
            `[b3] ${viewport.name} ${scheme}: confirm press ${press?.width.toFixed(0)}x${press?.height.toFixed(0)} right ${press?.right.toFixed(0)} <= ${press?.sectionRight.toFixed(0)}, scrollWidth ${press?.scrollWidth} <= ${press?.viewport}`,
          );
          expect(press, 'the press is on screen').toBeDefined();
          expect(press?.right ?? 999_999, 'inside its section').toBeLessThanOrEqual(press?.sectionRight ?? 0);
          expect(press?.scrollWidth ?? 999_999, 'no sideways scroll').toBeLessThanOrEqual(press?.viewport ?? 0);
          await shot('none-stepup');
          await tab.locator('[data-confirm-to-see] button').click();
          await tab.waitForSelector('[data-project-accounts-edit]');
          expect(await tab.locator('[data-project-accounts-edit]').textContent()).toBe('Link an account');
          expect(await tab.locator('[data-confirm-to-see]').count(), 'the press is gone once read').toBe(0);
          await shot('none-unlocked');
        }));

      it(`shows a removed default in the editor and lets the owner pick a new one (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, 'case=removed', async (tab, shot) => {
          await tab.waitForSelector('[data-project-accounts-edit]');
          await tab.locator('[data-project-accounts-edit]').click();
          await tab.waitForSelector('[data-project-accounts-editor]');
          const removedRow = tab.locator('[data-project-accounts-choice="gha_gone"]');
          expect(await removedRow.textContent()).toContain('account removed');
          expect(await tab.locator('[data-project-accounts-default-gone]').count(), 'the warning shows at once').toBe(
            1,
          );
          await tab.locator('[data-project-accounts-choice="gha_2"] input').click();
          await tab.waitForSelector('[data-project-accounts-default-gone]');
          await shot('removed-default');
          const rows = await inside(tab, '[data-project-accounts-editor] li');
          const button = (await inside(tab, '[data-project-accounts-make-default]'))[0];
          console.info(
            `[b3] ${viewport.name} ${scheme}: rows ${rows.map(row => `${row.width.toFixed(0)}x${row.height.toFixed(0)}`).join('/')}, make-default ${button?.width.toFixed(0)}x${button?.height.toFixed(0)} right ${button?.right.toFixed(0)} <= ${button?.sectionRight.toFixed(0)}, scrollWidth ${button?.scrollWidth} <= ${button?.viewport}`,
          );
          for (const row of rows)
            expect(row.right, 'a row stays inside the section').toBeLessThanOrEqual(row.sectionRight);
          expect(button?.right ?? 999_999, 'Make default stays inside the section').toBeLessThanOrEqual(
            button?.sectionRight ?? 0,
          );
          expect(button?.scrollWidth ?? 999_999, 'no sideways scroll').toBeLessThanOrEqual(button?.viewport ?? 0);
          await tab.locator('[data-project-accounts-make-default="gha_2"]').click();
          await tab.waitForFunction(() => document.querySelector('[data-project-accounts-default-gone]') === null);
          expect(await tab.locator('[data-project-accounts-choice="gha_2"]').textContent()).toContain('default');
          await shot('new-default');
        }));
    }
});
