/**
 * SETTINGS › UPDATES, in a real browser over fixed fake data (`fixtures/updates-settings-scene.tsx`): the "This app"
 * group names the build this browser runs and says whether it matches the machine — matching, newer, older or unknown —
 * and none of it overflows the screen at phone and desktop width.
 *
 * Set `FY_UPDATES_SETTINGS_SHOTS_DIR` to keep `<viewport>-<scheme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_UPDATES_SETTINGS_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;

/** The machine runs 4.28.0; each state is one build this browser could be running. */
const STATES = [
  { name: 'match', app: '4.28.0', version: '4.28.0', badge: 'Matches this machine' },
  { name: 'newer', app: '4.30.0', version: '4.30.0', badge: 'Newer than this machine' },
  { name: 'older', app: '4.27.0', version: '4.27.0', badge: 'Older than this machine' },
  { name: 'unknown', app: undefined, version: 'Unknown', badge: 'Unknown' },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-updates-settings-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/updates-settings-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the updates settings scene did not build (${code}):\n${stderr}\n${stdout}`);
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

describe('Settings › Updates › This app, drawn in a browser', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      for (const state of STATES)
        it(`names the build and says how it stands against the machine (${viewport.name}, ${mode}, ${state.name})`, async () => {
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
          await tab.goto(`${origin}/?theme=studio-${mode}${state.app === undefined ? '' : `&app=${state.app}`}`);
          await tab.waitForSelector('[data-scene="ready"]');
          if (shotsDir !== '')
            await tab.screenshot({
              path: join(shotsDir, `${viewport.name}-${mode}-${state.name}.png`),
              fullPage: true,
            });
          const measured = await tab.evaluate(() => {
            const group = document.querySelector<HTMLElement>('[data-setting-group="This app"]');
            const rows = [...(group?.querySelectorAll<HTMLElement>('[data-setting-row]') ?? [])].map(row => ({
              name: row.getAttribute('data-setting-row'),
              text: row.textContent ?? '',
              right: row.getBoundingClientRect().right,
              controlsRight: row.querySelector('[data-setting-controls]')?.getBoundingClientRect().right ?? 0,
            }));
            return { rows, width: window.innerWidth, scroll: document.documentElement.scrollWidth };
          });
          expect(measured.rows.map(row => row.name)).toEqual(['Version', 'Match']);
          expect(measured.rows[0]?.text).toContain(state.version);
          expect(measured.rows[1]?.text).toContain(state.badge);
          expect(measured.scroll, 'the page does not scroll sideways').toBeLessThanOrEqual(measured.width);
          for (const row of measured.rows)
            expect(row.controlsRight, `${row.name} keeps its control on screen`).toBeLessThanOrEqual(measured.width);
          await context.close();
        });
});
