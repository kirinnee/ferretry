/**
 * r11 S8 in a real browser: New ferret lists the owner's projects FIRST, and the project page starts a ferret THERE.
 *
 * The owner's line (via britnee): "how do I start it in a project?" New ferret's Folder box said "No ferret has been
 * started in a folder yet" on a machine with projects and no ferret history, and the project page had a second, weaker
 * start form (full-width buttons, a typed runtime, a raw mono sentence). Fake daemon, no network. Set
 * `FY_START_HERE_SHOTS_DIR` to keep `<viewport>-<scheme>-<shot>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_START_HERE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-start-here-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/start-here-scene.tsx'],
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
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

const calls = (tab: Page) => tab.evaluate(() => (window as unknown as { __calls: { route: string }[] }).__calls);

const withTab = async (
  viewport: Viewport,
  scheme: 'light' | 'dark',
  run: (
    tab: Page,
    open: (query: string, ready: string) => Promise<void>,
    shot: (name: string) => Promise<void>,
  ) => Promise<void>,
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
  const open = async (query: string, ready: string): Promise<void> => {
    await tab.goto(`${origin}/?theme=studio-${scheme}&${query}`);
    await tab.waitForSelector(ready, { timeout: 15_000 });
    await tab.waitForTimeout(250);
  };
  const shot = async (name: string): Promise<void> => {
    if (shotsDir !== '')
      await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${name}.png`), fullPage: true });
  };
  try {
    await run(tab, open, shot);
  } finally {
    await context.close();
  }
};

const CHOSEN = '[data-chosen-folder]';
const chosen = (tab: Page): Promise<string | null> => tab.locator(CHOSEN).getAttribute('data-chosen-folder');
const noSideways = async (tab: Page): Promise<void> => {
  const widths = await tab.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll, 'no sideways scroll').toBeLessThanOrEqual(widths.client);
};

describe('New ferret: where it works (Folder | Project)', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      const surface = viewport.phone ? 'sheet' : 'panel';

      it(`Project (the default with projects): a searchable dropdown that picks a project's folder (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=new&projects=2', '[data-where-project-trigger]');
          const state = await tab.evaluate(() => ({
            pressed: [...document.querySelectorAll('[data-new-ferret-where-switch] [role="radio"]')].map(button => [
              button.textContent,
              button.getAttribute('aria-checked'),
            ]),
            height: document.querySelector('[data-where-project-trigger]')?.getBoundingClientRect().height ?? 0,
            label: document.querySelector('label[for]')?.getAttribute('for') ?? undefined,
            triggerId: document.querySelector('[data-where-project-trigger]')?.id,
          }));
          expect(state.pressed).toEqual([
            ['Project', 'true'],
            ['Folder', 'false'],
          ]);
          expect(
            state.height,
            'a finger-sized target on a phone, the compact control on a desktop',
          ).toBeGreaterThanOrEqual(viewport.phone ? 44 : 32);
          expect(state.triggerId, 'the page label points at the control').toBe(state.label);
          await noSideways(tab);
          await shot('project');

          await tab.locator('[data-where-project-trigger]').click();
          await tab.waitForSelector('[data-where-project-row]');
          expect(
            await tab.locator(`[data-where-surface="${surface}"]`).count(),
            'a sheet on a phone, a panel on a desktop',
          ).toBe(1);
          const rows = await tab
            .locator('[data-where-project-row] button[title]')
            .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
          expect(rows).toHaveLength(2);
          console.info(
            `[o9-9] ${viewport.name} ${scheme}: project row heights ${rows.map(height => height.toFixed(0)).join('/')}`,
          );
          for (const height of rows) expect(height, 'a row is a touch target').toBeGreaterThanOrEqual(43.5);
          await noSideways(tab);
          await tab.waitForTimeout(450); // the sheet's slide-in
          await shot('project-open');

          await tab.locator('[data-where-project-search]').fill('fake-org');
          expect(await tab.locator('[data-where-project-row]').count(), 'search narrows by repository').toBe(1);
          await tab.locator('[data-where-project-search]').fill('');
          await tab.locator('[data-where-project-row] button[title]').nth(1).click();
          expect(await chosen(tab)).toBe('/fake/p2');
          await tab.waitForSelector('[data-where-project-row]', { state: 'detached' });
          expect(await tab.locator('[data-where-project-trigger]').textContent()).toContain('project-2');
          await shot('project-picked');
        }));

      it(`Project: Link GitHub opens the account editor in place and picks nothing (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=new&projects=2', '[data-where-project-trigger]');
          await tab.locator('[data-where-project-trigger]').click();
          await tab.locator('[data-where-link-github]').nth(1).click();
          await tab.waitForSelector('[data-where-link-panel] [data-project-accounts-editor]');
          expect(await chosen(tab), 'linking a project does not pick it').toBe('');
          await noSideways(tab);
          await tab.waitForTimeout(450);
          await shot('project-link-github');
        }));

      it(`Project: with no GitHub account connected, Link GitHub offers the existing connect card (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=new&projects=2&accounts=0', '[data-where-project-trigger]');
          await tab.locator('[data-where-project-trigger]').click();
          await tab.locator('[data-where-link-github]').nth(1).click();
          await tab.waitForSelector('[data-where-link-panel] [data-fake-connect-card]');
          expect(await tab.locator('[data-fake-connect-card]').textContent()).toBe('Connect a GitHub account');
          expect(await chosen(tab), 'connecting does not pick the project').toBe('');
          await noSideways(tab);
          await tab.waitForTimeout(450);
          await shot('project-connect-github');
        }));

      it(`Folder: recent folders are one-tap, and Browse opens the project-setup finder (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=new&projects=2&recent=3', '[data-where-project-trigger]');
          await tab.getByRole('radio', { name: 'Folder', exact: true }).click();
          await tab.waitForSelector('[data-new-ferret-where-folder]');
          expect(await tab.locator('[data-where-recent-folder]').count()).toBe(3);
          await noSideways(tab);
          await shot('folder');

          await tab.locator('[data-where-recent-folder]').nth(1).click();
          expect(await chosen(tab)).toBe('/fake/work/web-redesign');
          expect(await tab.locator('#fy-new-ferret-folder').inputValue()).toBe('/fake/work/web-redesign');

          await tab.locator('[data-where-browse]').click();
          await tab.waitForSelector(`[data-where-surface="${surface}"]`);
          await tab.getByRole('button', { name: 'Use this folder' }).waitFor();
          await noSideways(tab);
          await tab.waitForTimeout(450);
          await shot('folder-browse');
          await tab.getByRole('button', { name: 'Use this folder' }).click();
          expect(await chosen(tab)).toBe('/fake/work');
          await tab.waitForSelector(`[data-where-surface="${surface}"]`, { state: 'detached' });
        }));
    }

  it('opens on Folder on a daemon with no projects', () =>
    withTab(VIEWPORTS[0], 'light', async (tab, open) => {
      await open('view=new&projects=0', '[data-new-ferret-where-folder]');
      expect(await tab.locator('[data-where-project-trigger]').count()).toBe(0);
      expect(await tab.locator('#fy-new-ferret-folder').count()).toBe(1);
    }));
});

describe('the project page', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`starts a ferret here with one fixed-width button and no form of its own (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, async (tab, open, shot) => {
          await open('view=project&projects=2', '[data-project-detail]');
          await shot('project-page');

          const buttons = tab.getByRole('button', { name: 'Start a ferret here' });
          expect(await buttons.count(), 'one start button').toBe(1);
          expect(await tab.getByRole('button', { name: /Start a ferret$/u }).count(), 'no second start').toBe(0);
          const box = await buttons.boundingBox();
          const row = await tab.evaluate(() => document.documentElement.clientWidth);
          console.info(
            `[s8] ${viewport.name} ${scheme}: start button ${box?.width.toFixed(1)} x ${box?.height.toFixed(1)}, viewport ${row}`,
          );
          expect(box, 'the button is drawn').not.toBeNull();
          const at = box as NonNullable<typeof box>;
          if (!viewport.phone) expect(Math.abs(at.width - 136), 'fixed 136px width').toBeLessThanOrEqual(1);
          else expect(at.x + at.width, 'inside the viewport').toBeLessThanOrEqual(row);
          expect(at.height).toBeGreaterThanOrEqual(44);
          // The label sits INSIDE the button with room on both sides (it once ran to the right edge at 390).
          const gaps = await buttons.evaluate(button => {
            const range = document.createRange();
            range.selectNodeContents(button);
            const lines = [...range.getClientRects()];
            const box = button.getBoundingClientRect();
            return {
              left: Math.min(...lines.map(line => line.left)) - box.left,
              right: box.right - Math.max(...lines.map(line => line.right)),
              fits: button.scrollWidth <= button.clientWidth + 1,
            };
          });
          console.info(
            `[s8] ${viewport.name} ${scheme}: label gaps ${gaps.left.toFixed(1)} / ${gaps.right.toFixed(1)}`,
          );
          expect(gaps.fits, 'the label does not overflow the button').toBe(true);
          expect(Math.min(gaps.left, gaps.right), 'room on both sides of the label').toBeGreaterThanOrEqual(6);
          expect(Math.abs(gaps.left - gaps.right), 'the label is centred').toBeLessThanOrEqual(4);
          expect(await tab.locator('#project-launch-runtime, #project-launch-runtime-name').count()).toBe(0);
          expect(await tab.getByText(/^Top-level interactive/u).count(), 'no raw mono sentence').toBe(0);
          expect(await tab.getByText('Starts in this project’s folder').count()).toBe(1);

          await buttons.click();
          await tab.waitForURL(/\/d\/fake\/new\?folder=%2Ffake%2Fp1$/u);
          expect(
            (await calls(tab)).filter(call => call.route === 'POST /v1/ferrets'),
            'the page itself starts nothing',
          ).toHaveLength(0);
        }));
});
