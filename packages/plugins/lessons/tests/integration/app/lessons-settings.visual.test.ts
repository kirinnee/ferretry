/**
 * SETTINGS › LESSONS, in a real browser over a fake daemon (`fixtures/lessons-settings-scene.tsx`): each ferret's
 * Turn on / Turn off sits level with its On / Off chip and in the same column as the rows above and below it, and the Global
 * lessons box is at least five lines tall, so a rule is read without scrolling inside it.
 *
 * Set `FY_LESSONS_SETTINGS_SHOTS_DIR` to keep `<viewport>-<scheme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LESSONS_SETTINGS_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '768', width: 768, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-lessons-settings-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/lessons-settings-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the lessons settings scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

describe('Settings › Lessons, drawn in a browser', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`aligns each ferret's switch with its row and gives the Global lessons box five lines (${viewport.name}, ${mode})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: mode,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        await tab.goto(`${origin}/?theme=studio-${mode}`);
        await tab.waitForSelector('[data-scene="ready"]');
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}.png`), fullPage: true });
        const measured = await tab.evaluate(() => {
          const rows = [...document.querySelectorAll<HTMLElement>('[data-lessons-ferret]')].map(row => {
            const box = row.getBoundingClientRect();
            const button = row.querySelector('button')?.getBoundingClientRect();
            const chip = [...row.querySelectorAll('span')]
              .find(node => ['On', 'Off'].includes((node.textContent ?? '').trim()) && node.children.length === 0)
              ?.getBoundingClientRect();
            return {
              buttonLeft: button?.left ?? 0,
              buttonRight: button?.right ?? 0,
              buttonCenter: ((button?.top ?? 0) + (button?.bottom ?? 0)) / 2,
              rowCenter: (box.top + box.bottom) / 2,
              chipCenter: ((chip?.top ?? 0) + (chip?.bottom ?? 0)) / 2,
              chipLeft: chip?.left ?? 0,
            };
          });
          const names = [...document.querySelectorAll<HTMLElement>('[data-lessons-ferret]')].map(row =>
            (row.querySelector('[id$="-label"]')?.textContent ?? '').trim(),
          );
          const area = document.querySelector<HTMLTextAreaElement>('[data-global-lessons] textarea');
          const line = parseFloat(getComputedStyle(area as Element).lineHeight);
          return { rows, names, areaHeight: area?.getBoundingClientRect().height ?? 0, line };
        });
        expect(measured.rows.length).toBe(5);
        expect(measured.names, 'a gone ferret shows its stored name, not its id').toEqual([
          'Hadi',
          'Mira',
          'Oden',
          'Zed',
          'ferret-g…',
        ]);
        for (const row of measured.rows) {
          expect(Math.abs(row.buttonCenter - row.rowCenter), 'the button is level with its row').toBeLessThanOrEqual(1);
          expect(Math.abs(row.buttonCenter - row.chipCenter), 'the button is level with its chip').toBeLessThanOrEqual(
            1,
          );
        }
        // One column: every row's button starts, and ends, at the same x.
        const lefts = measured.rows.map(row => Math.round(row.buttonLeft));
        const rights = measured.rows.map(row => Math.round(row.buttonRight));
        expect(new Set(lefts).size, `buttons start at one x (${lefts.join(', ')})`).toBe(1);
        expect(new Set(rights).size, `buttons end at one x (${rights.join(', ')})`).toBe(1);
        expect(measured.areaHeight, 'the box shows at least five lines').toBeGreaterThanOrEqual(measured.line * 5);
        await context.close();
      });
});
