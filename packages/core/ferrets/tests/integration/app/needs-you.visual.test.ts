/**
 * THE FERRET LIST'S NEEDS YOU GROUP AND ITS SETTINGS ROW, in a real browser over fake data (`fixtures/needs-you-scene.tsx`):
 * the real list and the real panel; no daemon.
 *
 *  - With "Group Needs you at the top" on, the ferrets that wait on the owner sit under "Needs you" above the folders;
 *    with it off they stay in their folders, still bold and badged.
 *  - Settings › This device carries the row, on until turned off.
 *
 * Set `FY_DEVICE_CONTROLS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_DEVICE_CONTROLS_SHOTS_DIR ?? '';

/** The shared Chromium and one of its pages, typed from the harness that makes them (this package holds no browser driver of its own). */
type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-needs-you-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/needs-you-scene.tsx'],
    {
      cwd: packageRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the needs-you scene did not build (${code}):\n${stderr}\n${stdout}`);
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

describe('the ferret list', () => {
  for (const variant of VARIANTS) {
    for (const group of [true, false]) {
      const label = group ? 'needs-you-on' : 'needs-you-off';
      it(`${variant.name}: ${label} — the ferrets that wait on you ${group ? 'sit under "Needs you"' : 'stay in their folders'}`, async () => {
        const { tab, close } = await open(variant, group ? 'view=list' : 'view=list&group=0', '[data-sbar-needs-you]');
        try {
          const groups = await tab
            .locator('section.fy-sbar__group')
            .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
          if (group) {
            expect(groups[0]).toBe('Needs you');
            expect(await tab.locator('[data-sbar-needs-you-group] [data-sbar-session]').count()).toBe(2);
          } else {
            expect(groups).not.toContain('Needs you');
            expect(await tab.locator('[data-sbar-needs-you]').count()).toBe(2);
          }
          expect(await tab.locator('[data-sbar-unread]').allTextContents()).toContain('2');
          await shotOf(tab, variant, label);
        } finally {
          await close();
        }
      });
    }
  }
});

describe('Settings › This device › Group Needs you at the top', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: the row is there, on, with its words`, async () => {
      const { tab, close } = await open(variant, 'view=row', '[data-setting-row="Group Needs you at the top"]');
      try {
        expect(await tab.locator('[role="switch"]').getAttribute('aria-checked')).toBe('true');
        expect(await tab.locator('body').innerText()).toContain('Sessions with open Inbox items go first');
        await shotOf(tab, variant, 'group-needs-you-row');
      } finally {
        await close();
      }
    });
  }
});
