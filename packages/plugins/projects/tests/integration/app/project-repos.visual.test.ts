/**
 * F-101 in a real browser: the project page lists its repositories and clones another one into the project. The REAL detail
 * page over a scripted daemon (fake names, no network), at 390 and 1440, light and dark, in the default look (Studio) and in
 * the two roundest looks (Gen Z, Neumorphism), asserting the round-safe rule and no sideways scroll in each state.
 *
 *   list      two repositories held, the form ready
 *   none      none held yet
 *   bad       an address git must not be handed: the warning, the button off
 *   busy      a clone under way: the button says so, the field is off
 *   refused   the daemon refused: its sentence quoted, the address kept
 *   cloned    the clone answered: the new repository is in the list and the field is empty
 *
 * Set `FY_PROJECT_REPOS_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PROJECT_REPOS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-project-repos-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/project-repos-scene.tsx'],
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
    port: Number(process.env.FY_PROJECT_REPOS_TEST_PORT ?? '7498'),
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

const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
] as const;
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;
const URL_OK = 'https://github.com/fake-org/cloned.git';
const type = async (page: Page, value: string) => await page.fill('[data-project-clone-url]', value);

const STATES: readonly { name: string; query: string; act?: (page: Page) => Promise<void>; waitFor: string }[] = [
  { name: 'list', query: 'repos=2', waitFor: '[data-project-repo="docs"]' },
  { name: 'none', query: 'repos=0', waitFor: '[data-project-repos="none"]' },
  {
    name: 'bad',
    query: 'repos=2',
    act: async page => await type(page, 'ext::sh -c x'),
    waitFor: '[data-project-clone-submit][disabled]',
  },
  {
    name: 'busy',
    query: 'repos=2&clone=slow',
    act: async page => {
      await type(page, URL_OK);
      await page.click('[data-project-clone-submit]');
    },
    waitFor: '[data-project-clone-url][disabled]',
  },
  {
    name: 'refused',
    query: 'repos=2&clone=refused',
    act: async page => {
      await type(page, URL_OK);
      await page.click('[data-project-clone-submit]');
    },
    waitFor: '[data-project-clone-refused]',
  },
  {
    name: 'credentials',
    query: 'repos=2',
    act: async page => await type(page, 'https://fixture-user:fixture-secret@example.invalid/repo.git'),
    waitFor: '[data-project-clone-refused]',
  },
  {
    name: 'local',
    query: 'repos=2',
    act: async page => await type(page, 'file:///synthetic/outside/repo.git'),
    waitFor: '[data-project-clone-submit][disabled]',
  },
  {
    name: 'cloned',
    query: 'repos=2&clone=ok',
    act: async page => {
      await type(page, URL_OK);
      await page.click('[data-project-clone-submit]');
    },
    waitFor: '[data-project-repo="cloned"]',
  },
];

for (const look of LOOKS)
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      describe(`project repositories: ${look.style} ${viewport.name} ${scheme}`, () => {
        for (const state of STATES)
          it(state.name, async () => {
            const context = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              deviceScaleFactor: viewport.phone ? 2 : 1,
              hasTouch: viewport.phone,
              isMobile: viewport.phone,
              colorScheme: scheme,
              reducedMotion: 'reduce',
            });
            try {
              const origin = server?.url.origin ?? '';
              await context.route('**/*', async route =>
                new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
              );
              const page = await context.newPage();
              await page.goto(`${origin}/?theme=${look.palette}-${scheme}&${state.query}`);
              await page.evaluate(style => document.documentElement.setAttribute('data-style', style), look.style);
              await page.waitForSelector('[data-project-clone-url]');
              await page.evaluate(async () => await document.fonts.ready);
              await state.act?.(page);
              await page.waitForSelector(state.waitFor);
              await page.waitForTimeout(400);
              await page.locator('[data-project-repos]').scrollIntoViewIfNeeded();
              if (shotsDir !== '') {
                await page.screenshot({
                  path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${state.name}.png`),
                  fullPage: true,
                });
                await page.locator('[data-project-repos]').screenshot({
                  path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${state.name}-form.png`),
                });
              }
              const misses = await roundSafeMisses(page);
              expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
              const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
              );
              expect(overflow, 'the page never scrolls sideways').toBeLessThanOrEqual(0);
              if (state.name === 'cloned')
                expect(await page.inputValue('[data-project-clone-url]'), 'the address is cleared').toBe('');
              if (state.name === 'refused')
                expect(await page.inputValue('[data-project-clone-url]'), 'the address is kept').toBe(URL_OK);
              if (state.name === 'credentials') {
                expect(await page.inputValue('[data-project-clone-url]')).toBe('');
                expect(await page.locator('[data-project-clone-refused]').innerText()).toContain(
                  'Accounts and secrets',
                );
                expect(await page.content()).not.toContain('fixture-secret');
                expect(await page.locator('[data-project-clone-submit]').isDisabled()).toBe(true);
              }
            } finally {
              await context.close();
            }
          });
      });
