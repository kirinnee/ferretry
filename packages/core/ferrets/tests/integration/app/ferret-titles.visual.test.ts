/**
 * ONE TASK-LIKE TITLE PER FERRET AND NO CALLSIGN LINE, in a real browser over fake data (`fixtures/ferret-titles-scene.tsx`):
 * the real list and the real header name; no daemon.
 *
 *  - The drawer's rows (an owner's title, a conversation's title, an untitled ferret) carry no callsign line: no
 *    `[data-sbar-ferret]`, and no row's visible text contains its ferret's callsign. The untitled row shows its folder's name.
 *  - The chat header shows the title alone (no `[data-ferret-callsign]`); the callsign stays in the tooltip.
 *
 * Set `FY_FERRET_TITLES_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_FERRET_TITLES_SHOTS_DIR ?? '';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-ferret-titles-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/ferret-titles-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the ferret titles scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

const open = async (variant: (typeof VARIANTS)[number], query: string, ready: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${variant.scheme}&${query}`);
  try {
    await tab.waitForSelector(ready, { timeout: 8_000 });
  } catch (error) {
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: (typeof VARIANTS)[number], name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const CALLSIGNS = ['zoe', 'kai', 'ora'];

describe("the drawer's ferret rows", () => {
  for (const variant of VARIANTS)
    it(`${variant.name}: each row is its title (or its folder) with no callsign line`, async () => {
      const { tab, close } = await open(variant, 'view=list', '[data-sbar-session]');
      try {
        expect(await tab.locator('[data-sbar-ferret]').count(), 'no callsign line is drawn').toBe(0);
        const rows = await tab
          .locator('[data-sbar-session]')
          .evaluateAll(nodes =>
            nodes.map(node => ({ id: node.getAttribute('data-sbar-session'), text: (node as HTMLElement).innerText })),
          );
        expect(rows.length).toBe(3);
        for (const row of rows)
          for (const callsign of CALLSIGNS)
            expect(row.text.toLowerCase(), `${row.id} shows ${callsign}`).not.toContain(callsign);
        const titleOf = async (id: string) =>
          await tab.locator(`[data-sbar-session="${id}"] .fy-sbar__name`).innerText();
        expect(await titleOf('f-zoe')).toBe('Fix stuck sign-in');
        expect(await titleOf('f-kai')).toBe('Fix Flaky Login Test');
        expect(await titleOf('f-ora')).toBe('handbook');
        await shotOf(tab, variant, 'drawer');
      } finally {
        await close();
      }
    });
});

describe('the chat header name', () => {
  for (const variant of VARIANTS)
    it(`${variant.name}: the title alone, the callsign only in the tooltip`, async () => {
      const { tab, close } = await open(variant, 'view=header&ferret=f-kai', '[data-ferret-name]');
      try {
        expect(await tab.locator('[data-ferret-callsign]').count()).toBe(0);
        expect(await tab.locator('[data-ferret-name]').innerText()).toBe('Fix Flaky Login Test');
        expect(await tab.locator('[data-ferret-name]').getAttribute('title')).toContain('Kai');
        await shotOf(tab, variant, 'header');
      } finally {
        await close();
      }
    });
});
