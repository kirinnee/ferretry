/**
 * O9-9 fix round, in a real browser: Projects' REAL "where it works" panel inside Ferrets' REAL `NewFerretPage` (no
 * stand-in on either side, `fixtures/new-ferret-real-scene.tsx`).
 *
 *  1. The path a start SENDS is always the one the visible mode SHOWS: a folder picked under Folder is not sent while
 *     Project says "Choose a project".
 *  2. On a desktop the project dropdown is a real dialog: opening it puts focus on its search box, Escape closes it and
 *     focus is back on the trigger (a keyboard test; the Folder finder's Browse… behaves the same).
 *
 * Fake daemon, no network. Set `FY_O9_9_FIX_SHOTS_DIR` to keep `<viewport>-<scheme>-<shot>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_O9_9_FIX_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-o9-9-fix-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/new-ferret-real-scene.tsx'],
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

interface Recorded {
  route: string;
  headers: Record<string, string> | undefined;
  body: unknown;
}
const startsOf = (tab: Page): Promise<Recorded[]> =>
  tab.evaluate(() =>
    (window as unknown as { __calls: Recorded[] }).__calls.filter(call => call.route === 'POST /v1/ferrets'),
  );
const folderOf = (start: Recorded | undefined): string | undefined =>
  (start?.body as { folder?: string } | undefined)?.folder;

const TRIGGER = '[data-where-project-trigger]';
const FOLDER_BOX = '[data-new-ferret-where-folder] input';

const withTab = async (
  viewport: Viewport,
  scheme: 'light' | 'dark',
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
  tab.setDefaultTimeout(10_000);
  try {
    await tab.goto(`${origin}/?theme=studio-${scheme}`);
    await tab.waitForSelector(TRIGGER);
    // The recent folders come from the ferret list the page reads once; wait until the page has them.
    await tab.waitForFunction(() =>
      (window as unknown as { __calls: { route: string }[] }).__calls.some(call => call.route === 'GET /v1/ferrets'),
    );
    await tab.waitForTimeout(300);
    const shot = async (name: string): Promise<void> => {
      if (shotsDir !== '') {
        await tab.waitForTimeout(600); // the segmented highlight, the button's fade and a sheet's slide settle
        const path = (suffix: string): string => join(shotsDir, `${viewport.name}-${scheme}-${name}${suffix}.png`);
        await tab.screenshot({ fullPage: true, path: path('') });
        // The page scrolls inside its own frame: a second frame brings Create ferret and its hint into view.
        await tab.getByRole('button', { name: 'Create ferret' }).scrollIntoViewIfNeeded();
        await tab.waitForTimeout(200);
        await tab.screenshot({ path: path('-create') });
      }
    };
    await run(tab, shot);
  } finally {
    await context.close();
  }
};

const fillRest = async (tab: Page): Promise<void> => {
  await tab.fill('#fy-new-ferret-runtime', 'claude-auto-loge');
  await tab.fill('#fy-new-ferret-prompt', 'Port the page');
};
const createButton = (tab: Page) => tab.getByRole('button', { name: 'Create ferret' });
const modeButton = (tab: Page, name: 'Folder' | 'Project') => tab.getByRole('radio', { name, exact: true });
const noSideways = async (tab: Page): Promise<void> => {
  const widths = await tab.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll, 'no sideways scroll').toBeLessThanOrEqual(widths.client);
};

describe('New ferret: the path a start sends is the one the visible mode shows', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`a Recent folder does not ride along under Project, and each mode keeps its own pick (${viewport.name}, ${scheme})`, () =>
        withTab(viewport, scheme, async (tab, shot) => {
          await fillRest(tab);
          expect(await modeButton(tab, 'Project').getAttribute('aria-checked'), 'opens on Project').toBe('true');

          // Folder: a Recent folder that is NOT a project.
          await modeButton(tab, 'Folder').click();
          await tab.locator('[data-where-recent-folder="/fake/scratch"]').click();
          expect(await tab.locator(FOLDER_BOX).inputValue()).toBe('/fake/scratch');
          expect(await createButton(tab).isEnabled(), 'a folder is chosen, so a start is possible').toBe(true);
          await shot('folder-picked');

          // Project: it says "Choose a project", so Create must not send the folder from the other mode.
          await modeButton(tab, 'Project').click();
          expect(await tab.locator(TRIGGER).textContent()).toContain('Choose a project');
          expect(await createButton(tab).isEnabled(), 'nothing is chosen under Project, so Create is off').toBe(false);
          await noSideways(tab);
          await shot('project-nothing-chosen');
          expect(await startsOf(tab), 'nothing was started').toHaveLength(0);

          // Back on Folder: its own pick is restored.
          await modeButton(tab, 'Folder').click();
          expect(await tab.locator(FOLDER_BOX).inputValue(), 'Folder restores its own pick').toBe('/fake/scratch');
          expect(await createButton(tab).isEnabled()).toBe(true);
          await shot('folder-restored');

          // Project again: pick one, start: the project's folder is what is sent.
          await modeButton(tab, 'Project').click();
          await tab.locator(TRIGGER).click();
          await tab.locator('[data-where-project-row] button[title]').first().click();
          expect(await tab.locator(TRIGGER).textContent()).toContain('site');
          await shot('project-picked');
          await createButton(tab).click();
          await tab.waitForFunction(() => (window as unknown as { __navigated: string[] }).__navigated.length > 0);
          const starts = await startsOf(tab);
          expect(starts, 'one start').toHaveLength(1);
          expect(folderOf(starts[0]), 'the project shown is the folder sent').toBe('/fake/site');
        }));

  it('switching back to Project restores that mode’s own project, and Folder keeps what it showed', () =>
    withTab(VIEWPORTS[0], 'light', async tab => {
      await tab.locator(TRIGGER).click();
      await tab.locator('[data-where-project-row] button[title]').nth(1).click();
      expect(await tab.locator(TRIGGER).textContent()).toContain('api');
      await modeButton(tab, 'Folder').click();
      await tab.locator('[data-where-recent-folder="/fake/notes"]').click();
      await modeButton(tab, 'Project').click();
      expect(await tab.locator(TRIGGER).textContent(), 'the project picked earlier is back').toContain('api');
      await modeButton(tab, 'Folder').click();
      expect(await tab.locator(FOLDER_BOX).inputValue()).toBe('/fake/notes');
    }));
});

describe('New ferret on a desktop: the project dropdown is a keyboard-usable dialog', () => {
  for (const scheme of ['light', 'dark'] as const)
    it(`Enter opens it onto the search box, Escape closes it and focus returns to the trigger (${scheme})`, () =>
      withTab(VIEWPORTS[0], scheme, async (tab, shot) => {
        const active = () =>
          tab.evaluate(() => {
            const element = document.activeElement;
            return {
              search: element?.hasAttribute('data-where-project-search') ?? false,
              trigger: element?.hasAttribute('data-where-project-trigger') ?? false,
            };
          });
        await tab.locator(TRIGGER).focus();
        await tab.keyboard.press('Enter');
        const dialog = tab.getByRole('dialog', { name: 'Choose a project' });
        await dialog.waitFor();
        expect(await tab.locator(TRIGGER).getAttribute('aria-expanded')).toBe('true');
        expect((await active()).search, 'focus moved to Search projects').toBe(true);
        await shot('project-open-focused');

        // Typing goes to the search box, and Escape from there closes the dialog.
        await tab.keyboard.type('si');
        expect(await tab.locator('[data-where-project-row]').count()).toBe(1);
        await tab.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        expect(await tab.locator(TRIGGER).getAttribute('aria-expanded')).toBe('false');
        expect((await active()).trigger, 'focus is back on the trigger').toBe(true);

        // It opens again with a clean search, and a keyboard pick returns focus to the trigger too.
        await tab.keyboard.press('Enter');
        await dialog.waitFor();
        expect(await tab.locator('[data-where-project-search]').inputValue(), 'a fresh search').toBe('');
        await tab.keyboard.press('Tab');
        await tab.keyboard.press('Enter');
        await dialog.waitFor({ state: 'detached' });
        expect((await active()).trigger, 'focus is back on the trigger after a pick').toBe(true);
        expect(await tab.locator(TRIGGER).textContent()).toContain('site');
      }));

  it('Browse… opens the folder finder as a dialog too: Escape closes it and focus returns to Browse…', () =>
    withTab(VIEWPORTS[0], 'light', async tab => {
      await modeButton(tab, 'Folder').click();
      const browse = tab.locator('[data-where-browse]');
      await browse.focus();
      await tab.keyboard.press('Enter');
      const dialog = tab.getByRole('dialog', { name: 'Choose a folder' });
      await dialog.waitFor();
      expect(await dialog.evaluate(element => element.contains(document.activeElement)), 'focus is inside').toBe(true);
      await tab.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      expect(await browse.evaluate(element => element === document.activeElement), 'focus is back on Browse…').toBe(
        true,
      );
    }));
});
