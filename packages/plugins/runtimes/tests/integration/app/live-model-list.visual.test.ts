/**
 * THE MODEL PICKER'S LIVE LIST in a real browser over fake data (`fixtures/live-model-list-scene.tsx`: Ferrets' REAL New ferret
 * page around Runtimes' REAL picker, so a picker that told the page again on every draw would loop here): the curated models,
 * then "New from DeepSeek", then "Custom id…"; the curated model the key lacks says so and stays pickable; a list read
 * three days ago says it is out of date; "Refresh list" is drawn only for a device that may press it; and the default the
 * first option names does not move. At 1440 (a popover) and 390 with touch (a dialog), light and dark.
 * Set `FY_RUNTIMES_LIVE_SHOTS_DIR` to keep `<viewport>-<theme>-<state>-<shot>.png`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_RUNTIMES_LIVE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-runtimes-live-list-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/live-model-list-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the live model list scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
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
const THEMES = ['light', 'dark'] as const;
const STATES = ['fresh', 'stale'] as const;

const open = async (
  viewport: (typeof VIEWPORTS)[number],
  theme: (typeof THEMES)[number],
  query: string,
): Promise<{ close: () => Promise<void>; tab: Page }> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
    colorScheme: theme,
  });
  const tab = await context.newPage();
  // A picker that tells the page again on every draw never stops drawing: React says so, once per pass.
  tab.on('console', message => {
    if (message.text().includes('Maximum update depth')) loops.push(message.text());
  });
  tab.on('pageerror', error => loops.push(error.message));
  await tab.goto(`${server?.url.origin ?? ''}/?theme=studio-${theme}&${query}`);
  await tab.waitForSelector(MODEL_FIELD);
  await tab.waitForSelector('[data-live-model-list]');
  return { tab, close: () => context.close() };
};

/** The model field of the REAL New ferret page. */
const MODEL_FIELD = '#fy-new-ferret-model';
const loops: string[] = [];
beforeEach(() => {
  loops.length = 0;
});

const shoot = async (tab: Page, viewport: string, theme: string, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await tab.waitForTimeout(450);
  await tab.screenshot({ animations: 'disabled', path: join(shotsDir, `${viewport}-${theme}-${name}.png`) });
};

describe('the model picker shows the login’s live list', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      for (const state of STATES)
        it(`${state} list: sections, badges, the stale line and Refresh list (${viewport.name}, ${theme})`, async () => {
          const { tab, close } = await open(viewport, theme, `state=${state}`);
          try {
            const line = tab.locator('[data-live-model-list]');
            expect(await line.getAttribute('data-live-model-list')).toBe(state);
            expect(await line.textContent()).toContain(
              state === 'stale' ? 'List out of date: read 3 days ago.' : 'List read 2 hours ago.',
            );
            expect(await tab.getByRole('button', { name: 'Refresh list' }).count(), 'a device that may configure').toBe(
              1,
            );
            expect(
              await tab.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
            ).toBe(false);
            await shoot(tab, viewport.name, theme, `${state}-closed`);
            await tab.click(MODEL_FIELD);
            await tab.waitForSelector('[role="option"]');
            const listed = await tab.evaluate(() => ({
              options: [...document.querySelectorAll('[role="option"]')].map(
                option => option.querySelector('[data-label]')?.textContent ?? '',
              ),
              groups: [...document.querySelectorAll('[role="group"]')].map(group => group.getAttribute('aria-label')),
              hints: [...document.querySelectorAll('[role="option"]')].map(
                option => option.querySelector('.fy-sb__hint')?.textContent ?? '',
              ),
            }));
            expect(listed.options).toEqual([
              'Login default (DeepSeek V4 Pro)',
              'DeepSeek V4 Pro',
              'DeepSeek Flash',
              'deepseek-v4-flash',
              'deepseek-v4-flash-vision-exp',
              'Custom id…',
            ]);
            // The slot hands the page each model's id, label and availability, not its tier, so the real page has no tier groups.
            expect(listed.groups).toEqual(['New from DeepSeek']);
            expect(listed.hints[2]).toContain('not offered to this key');
            expect(listed.hints[3]).toBe('not reviewed');
            await shoot(tab, viewport.name, theme, `${state}-open`);
            // The list scrolls inside its popover when it is long: "Custom id…" is the last row and can be reached.
            const reached = await tab.evaluate(() => {
              const scroller = document.querySelector<HTMLElement>('[role="listbox"]');
              const last = [...document.querySelectorAll<HTMLElement>('[role="option"]')].at(-1);
              scroller?.scrollTo({ top: scroller.scrollHeight });
              const box = scroller?.getBoundingClientRect();
              const row = last?.getBoundingClientRect();
              return {
                label: last?.querySelector('[data-label]')?.textContent,
                visible:
                  box !== undefined && row !== undefined && row.top >= box.top - 1 && row.bottom <= box.bottom + 1,
              };
            });
            expect(reached).toEqual({ label: 'Custom id…', visible: true });
            await shoot(tab, viewport.name, theme, `${state}-open-end`);
            // The newer model is offered, never adopted: picking nothing leaves the default where it was.
            await tab.keyboard.press('Escape');
            expect(await tab.textContent(MODEL_FIELD)).toContain('Login default');
            // The page settled: the picker asked the daemon once, never forced a read, and nothing looped.
            const routes = await tab.evaluate(() => (window as unknown as { __calls: { route: string }[] }).__calls);
            expect(routes.filter(call => call.route.endsWith('/model-list/refresh'))).toHaveLength(1);
            expect(routes.filter(call => call.route.endsWith('/model-list/force'))).toHaveLength(0);
            expect(loops).toEqual([]);
          } finally {
            await close();
          }
        });

  it('a limited device has no Refresh list button (390, light)', async () => {
    const { tab, close } = await open(VIEWPORTS[1], 'light', 'state=stale&refresh=0');
    try {
      expect(await tab.getByRole('button', { name: 'Refresh list' }).count()).toBe(0);
      expect(await tab.textContent('[data-live-model-list]')).toContain('List out of date');
      await shoot(tab, '390', 'light', 'stale-limited');
    } finally {
      await close();
    }
  });
});
