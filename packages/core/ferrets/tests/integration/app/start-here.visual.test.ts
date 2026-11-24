/**
 * r11 S8 in a real browser, Ferrets' half: on a machine with projects and NO ferret history, New ferret lists the
 * projects ABOVE the Folder box (the page's real slot order), says nothing of "no ferret has been started", opens with a
 * project's `?folder=` already in the box on the first render, and starts with the exact folder and a request id.
 *
 * Fake daemon, no network (`fixtures/new-ferret-projects-scene.tsx`). Set `FY_S8_FERRETS_SHOTS_DIR` to keep PNGs.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_S8_FERRETS_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-new-ferret-projects-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/new-ferret-projects-scene.tsx'],
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 900, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const FOLDER = '#fy-new-ferret-folder';
const ROWS = '[data-new-ferret-project-row]';
const OLD_COPY = 'No ferret on this daemon has been started in a folder yet';

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

const withTab = async (variant: Variant, query: string, run: (tab: Page) => Promise<void>): Promise<void> => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    colorScheme: variant.scheme,
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  try {
    await tab.goto(`${origin}/?theme=studio-${variant.scheme}${query}`);
    await tab.waitForSelector(FOLDER);
    // The Folder box's own read of the (empty) ferret list settles into its empty copy.
    await tab.waitForTimeout(300);
    await run(tab);
  } finally {
    await context.close();
  }
};

/** Fills the two fields a start needs besides the folder, then presses Create ferret. */
const create = async (tab: Page): Promise<void> => {
  await tab.fill('#fy-new-ferret-runtime', 'claude-auto-loge');
  await tab.fill('#fy-new-ferret-prompt', 'Port the page');
  await tab.getByRole('button', { name: 'Create ferret' }).click();
  await tab.waitForFunction(() => (window as unknown as { __navigated: string[] }).__navigated.length > 0);
};

describe('New ferret with projects and no ferret history', () => {
  for (const variant of VARIANTS)
    it(`${variant.name}: the page draws the where-it-works panel in the Folder's place, picking fills it, and the start is exact`, () =>
      withTab(variant, '', async tab => {
        const geometry = await tab.evaluate(
          ([folder, rows]) => ({
            sectionTop: document.querySelector('[data-new-ferret-projects]')?.getBoundingClientRect().top ?? -1,
            fieldTop: document.querySelector(folder as string)?.getBoundingClientRect().top ?? -1,
            rows: document.querySelectorAll(rows as string).length,
            body: document.body.innerText,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          }),
          [FOLDER, ROWS],
        );
        console.info(
          `[s8-ferrets] ${variant.name}: panel top ${geometry.sectionTop.toFixed(1)}, folder id top ${geometry.fieldTop.toFixed(1)}, rows ${geometry.rows}, scrollWidth ${geometry.scrollWidth} <= ${geometry.clientWidth}`,
        );
        expect(geometry.rows, 'two projects, two rows').toBe(2);
        expect(geometry.sectionTop, 'the real page draws the slot').toBeGreaterThanOrEqual(0);
        expect(geometry.fieldTop, 'the panel carries the id the page’s label points at').toBeGreaterThanOrEqual(0);
        expect(geometry.body, 'the old picker copy is gone').not.toContain(OLD_COPY);
        expect(geometry.body, 'the page draws no folder box of its own beside the panel').not.toContain(
          'No recent folders',
        );
        expect(geometry.scrollWidth, 'no sideways scroll').toBeLessThanOrEqual(geometry.clientWidth);
        if (shotsDir !== '') await tab.screenshot({ fullPage: true, path: join(shotsDir, `${variant.name}-new.png`) });

        // Picking project 2 fills the box with its folder, exactly as registered (it ends in a space).
        await tab.locator(ROWS).nth(1).click();
        expect(await tab.locator(FOLDER).inputValue()).toBe('/fake/p2 ');
        await create(tab);
        const starts = await startsOf(tab);
        console.info(
          `[s8-ferrets] ${variant.name}: ${starts.length} POST, folder ${JSON.stringify(folderOf(starts[0]))}, request id ${starts[0]?.headers?.['x-fy-request-id']}`,
        );
        expect(starts, 'one start').toHaveLength(1);
        expect(folderOf(starts[0]), 'the registered path, untrimmed').toBe('/fake/p2 ');
        expect(starts[0]?.headers?.['x-fy-request-id'] ?? '', 'a request id travels with the start').not.toBe('');
      }));

  for (const variant of VARIANTS)
    it(`${variant.name}: ?folder= is in the box on the first render and a start sends it exactly`, () =>
      withTab(variant, '&folder=%2Ffake%2Fp1', async tab => {
        const first = await tab.evaluate(() => (window as unknown as { __firstFolder?: string }).__firstFolder);
        console.info(`[s8-ferrets] ${variant.name}: first-render folder ${JSON.stringify(first)}`);
        expect(first, 'the prefill is there on the first commit').toBe('/fake/p1');
        expect(await tab.locator(FOLDER).inputValue()).toBe('/fake/p1');
        expect(await tab.locator(`${ROWS}[aria-pressed="true"]`).count(), 'the matching project row is marked').toBe(1);
        if (shotsDir !== '')
          await tab.screenshot({ fullPage: true, path: join(shotsDir, `${variant.name}-prefilled.png`) });
        await create(tab);
        const starts = await startsOf(tab);
        expect(starts, 'exactly one POST /v1/ferrets').toHaveLength(1);
        expect(folderOf(starts[0])).toBe('/fake/p1');
        expect(starts[0]?.headers?.['x-fy-request-id'] ?? '', 'with its request id').not.toBe('');
      }));
});

describe('a folder with a trailing space', () => {
  it('is carried verbatim from ?folder= into the start', async () => {
    await withTab(VARIANTS[0], '&folder=%2Ffake%2Fp2%20', async tab => {
      expect(await tab.locator(FOLDER).inputValue()).toBe('/fake/p2 ');
      await create(tab);
      expect(folderOf((await startsOf(tab))[0])).toBe('/fake/p2 ');
    });
  });
});
