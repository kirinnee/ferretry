/**
 * A TASK OPENED BY ITS LINK (`/task/F3`, and the former `/card/F3`) sits in the shell's main column, in a real browser: the
 * navigation and the machine picker stay on screen and answer a press, and the task never reaches past the column that
 * holds it. Phone and desktop, light and dark. Set `FY_BOARD_APP_SHOTS_DIR` to keep `<viewport>-<scheme>-<route>-task.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_BOARD_APP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-task-page-frame-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/task-page-frame-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the task page scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '390', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, phone: true },
  { name: '1440', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1, phone: false },
] as const;

const open = async (
  viewport: (typeof VIEWPORTS)[number],
  scheme: 'light' | 'dark',
  route: 'task' | 'card',
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: scheme,
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  tab.on('console', message => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await tab.goto(`${origin}/?theme=studio-${scheme}&route=${route}`);
  try {
    await tab.waitForSelector('aside[aria-label^="Task"]');
    await tab.waitForSelector('text=Rich CI cache summary');
  } catch (error) {
    const drawn = await tab.evaluate(() => document.body.innerText).catch(() => '');
    throw new Error(`the scene did not draw the task: ${String(error)}\n${problems.join('\n')}\npage: ${drawn}`);
  }
  return { tab, close: async () => await context.close() };
};

describe('a task opened by its link sits in the shell’s main column', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const route of ['task', 'card'] as const)
        it(`${route} link at ${viewport.name}, ${scheme}: the navigation and the machine picker stay usable`, async () => {
          const { tab, close } = await open(viewport, scheme, route);
          try {
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${route}-task.png`) });
            const seen = await tab.evaluate(() => {
              const box = (query: string) => document.querySelector(query)?.getBoundingClientRect();
              const hits = (query: string): boolean => {
                const element = document.querySelector(query);
                if (element === null) return false;
                const at = element.getBoundingClientRect();
                const top = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2);
                return top !== null && element.contains(top);
              };
              const main = box('[data-shell-main]');
              const task = box('aside[aria-label^="Task"]');
              return {
                navHit: hits('[data-shell-nav]'),
                machineHit: hits('[data-shell-machine]'),
                main:
                  main === undefined
                    ? null
                    : { left: main.left, right: main.right, top: main.top, bottom: main.bottom },
                task: task === undefined ? null : { left: task.left, right: task.right, top: task.top },
              };
            });
            expect(seen.navHit, 'the navigation is not covered').toBe(true);
            expect(seen.machineHit, 'the machine picker is not covered').toBe(true);
            expect(seen.task, 'the task is drawn').not.toBeNull();
            expect(seen.task?.left, 'the task starts inside the main column').toBeGreaterThanOrEqual(
              seen.main?.left ?? 0,
            );
            expect(seen.task?.right, 'the task ends inside the main column').toBeLessThanOrEqual(
              (seen.main?.right ?? 0) + 1,
            );
            expect(seen.task?.top, 'the task starts below the top of the main column').toBeGreaterThanOrEqual(
              seen.main?.top ?? 0,
            );
          } finally {
            await close();
          }
        }, 60_000);
});
