/**
 * THE AGENTS TAB, in a real browser: a desktop (1280) and a phone (390), light and dark, at rest and with changes
 * picked (so the apply panels draw). Nothing scrolls sideways, and the page draws.
 *
 * Set `FY_AGENTS_SHOTS_DIR` to keep `agents-<viewport>-<scheme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_AGENTS_SHOTS_DIR ?? '';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-agents-tab-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/agents-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the agents scene did not build (${code}):\n${stderr}\n${stdout}`);
  const built = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const [css, js] = [await readFile(built.css, 'utf8'), await readFile(built.js, 'utf8')];
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: auto !important; min-height: 0 !important; overflow: visible !important; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: 'desktop-1280', width: 1_280, height: 900, phone: false },
  { name: 'phone-390', width: 390, height: 844, phone: true },
] as const;

describe('the Agents tab in a browser', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`draws and does not scroll sideways: ${viewport.name}, ${scheme}`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const origin = server?.url.origin ?? '';
        const tab = await context.newPage();
        const problems: string[] = [];
        tab.on('pageerror', (error: Error) => problems.push(error.message));
        await tab.goto(`${origin}/?theme=studio-${scheme}`);
        await tab.waitForSelector('[data-agents-tab]', { timeout: 6_000 });
        const overflow = async (): Promise<number> =>
          await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const keep = async (state: string): Promise<void> => {
          expect(await overflow()).toBeLessThanOrEqual(0);
          if (shotsDir !== '')
            await tab.screenshot({
              path: join(shotsDir, `agents-${viewport.name}-${scheme}-${state}.png`),
              fullPage: true,
            });
        };
        await keep('rest');
        await tab.click('[role="radiogroup"] label:has(input[value="skip"])');
        await tab.click('[data-setting-row="Page scripts"] [role="switch"]');
        await tab.click('[data-setting-row="Agenda mode for new ferrets"] [data-setting-info]');
        await tab.waitForSelector('[data-change-submit]');
        await keep('changes-picked');
        expect(problems).toEqual([]);
        await context.close();
      });
});
