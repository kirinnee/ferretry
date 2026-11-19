/**
 * "CREATE A PROJECT" in a real browser, on a phone and a desktop, in light and dark, over fake data: the explorer as
 * cards and as a list, a deep path, a new folder, the accounts step with two accounts, the key offer, the done step, a
 * link to a removed account, and the old typed-path form it replaces. Set `FY_CREATE_PROJECT_SHOTS_DIR` to keep
 * `<viewport>-<scheme>-<shot>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CREATE_PROJECT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-create-project-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/create-project-scene.tsx'],
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

const noSideways = async (tab: Page): Promise<void> => {
  const overflow = await tab.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the screen does not scroll sideways').toBeLessThanOrEqual(0);
  // Content clipped by an ancestor does not scroll the page, so look at where every element ends too.
  const stray = await tab.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    return [...document.querySelectorAll('[data-scene-ready] *')]
      .filter(node => node.getBoundingClientRect().right > limit)
      .map(node => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}`)
      .slice(0, 3);
  });
  expect(stray, 'nothing is drawn past the right edge').toEqual([]);
};

describe('create a project', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`draws every step over fake data, with no sideways scroll (${viewport.name}, ${scheme})`, async () => {
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
          await noSideways(tab);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${name}.png`), fullPage: true });
        };
        const open = async (query: string): Promise<void> => {
          await tab.goto(`${origin}/?theme=studio-${scheme}&${query}`);
          await tab.waitForSelector('[data-scene-ready] .kt-panel > *', { timeout: 15_000 });
        };
        try {
          // Before: the typed path this replaces.
          await open('stage=before');
          await shot('before-typed-path');

          // The explorer, as cards and as a list, at the home folder.
          await open('stage=explorer&view=card');
          await tab.waitForSelector('[data-explorer-state="ready"]');
          expect(await tab.innerText('body')).toContain('Documents');
          await shot('explorer-cards');
          await open('stage=explorer&view=list');
          await tab.waitForSelector('[data-explorer-state="ready"]');
          await shot('explorer-list');

          // Deep: breadcrumbs and git badges.
          await open('stage=explorer&view=list&at=/home/sam/work/clients/acme');
          await tab.waitForSelector('[data-explorer-crumb="/home/sam/work/clients"]');
          expect(await tab.locator('[data-explorer-git-badge]').count()).toBe(2);
          await shot('explorer-deep');

          // New folder, inline.
          await tab.getByRole('button', { name: 'New folder' }).click();
          await tab.locator('[data-explorer-new-folder] input').fill('.hidden');
          await shot('explorer-new-folder');

          // The whole flow: pick, name, accounts (two), keys, done.
          await open('stage=flow&view=list');
          // On a phone the explorer opens in a sheet over the step.
          if (viewport.phone) {
            await shot('flow-folder-step');
            await tab.getByRole('button', { name: 'Choose a folder' }).click();
          }
          await tab.waitForSelector('[data-explorer-state="ready"]');
          if (viewport.phone) {
            await tab.waitForTimeout(500);
            await shot('flow-folder-sheet');
          }
          await tab.getByRole('button', { name: 'Use this folder' }).click();
          await tab.waitForSelector('[data-create-chosen]');
          await tab.waitForTimeout(500);
          await shot('flow-folder-chosen');
          await tab.getByRole('button', { name: 'Next' }).click();
          await tab.getByRole('button', { name: 'Create project' }).click();
          await tab.waitForSelector('[data-create-step="accounts"]');
          await tab.waitForSelector('[data-create-account="gha_202"]');
          await tab.locator('[data-create-account="gha_101"] input').check();
          await tab.locator('[data-create-account="gha_202"] input').check();
          await tab.getByRole('button', { name: 'Connect a GitHub account' }).click();
          await tab.waitForSelector('[data-connect-consent]');
          await tab.waitForTimeout(300);
          await shot('flow-accounts');
          await tab.getByRole('button', { name: 'Link these accounts' }).click();
          await tab.waitForSelector('[data-create-step="keys"]');
          await shot('flow-keys-offer');
          await tab.getByRole('button', { name: 'Set up push and signing for this account' }).click();
          await tab.waitForSelector('[data-create-key-account] [role="status"]');
          await shot('flow-keys-done');
          await tab.getByRole('button', { name: 'Continue' }).click();
          await tab.waitForSelector('[data-create-step="done"]');
          await shot('flow-done');

          // A link to an account that no longer exists.
          await open('stage=links');
          expect(await tab.innerText('body')).toContain('account removed');
          await shot('links-account-removed');
        } finally {
          await context.close();
        }
      });
});
