/**
 * THE SETUP FLOW'S PROJECT PAGE, "Add your projects" (C59 O8-13), in a real browser over fake data (`fixtures/folders-step-scene.tsx`):
 * the real step and explorer in the step frame, on a phone and a desktop, in light and dark. It proves: the page follows the
 * flow's frame (title, "Projects" bar segment, Back, "Skip for now", Next all on screen), the explorer picks one folder or several,
 * Next registers each as an existing folder and leaves where they are, nothing is about boards, and nothing scrolls sideways.
 * Set `FY_FOLDERS_STEP_SHOTS_DIR` to keep `<viewport>-<scheme>-<shot>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_FOLDERS_STEP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-folders-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/folders-step-scene.tsx'],
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

describe('the setup flow ends in project setup', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`follows the flow's frame, picks folders, registers them, and says nothing of boards (${viewport.name}, ${scheme})`, async () => {
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
        const problems: string[] = [];
        tab.on('pageerror', error => problems.push(error.message));
        try {
          await tab.goto(`${origin}/?theme=studio-${scheme}`);
          await tab.waitForSelector('[data-explorer-state="ready"]');
          const shot = async (name: string): Promise<void> => {
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${name}.png`), fullPage: true });
          };
          await shot('1-first');

          // The frame: its title, the "Projects" segment of the bar, and the three footer buttons, all on screen.
          const frame = await tab.evaluate(() => {
            const inside = (selector: string) => {
              const r = document.querySelector(selector)?.getBoundingClientRect();
              return (
                r !== undefined &&
                r.top >= 0 &&
                r.bottom <= window.innerHeight &&
                r.left >= 0 &&
                r.right <= window.innerWidth
              );
            };
            return {
              title: document.querySelector('.fy-spf__title')?.textContent,
              later: document.querySelector('[data-step-later]')?.textContent?.trim(),
              visible: ['[data-step-back]', '[data-step-later]', '[data-step-next]'].map(inside),
              text: document.body.innerText,
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          expect(frame.title).toBe('Add your projects');
          expect(frame.later).toBe('Skip for now');
          expect(frame.visible, 'Back, Skip for now and Next are all on screen').toEqual([true, true, true]);
          expect(frame.text).toContain('Projects');
          expect(frame.text.toLowerCase()).not.toMatch(/board|lane|backlog/u);
          expect(frame.overflow, 'no sideways scroll').toBeLessThanOrEqual(0);

          // Next with nothing picked refuses, in words, and registers nothing.
          await tab.click('[data-step-next]');
          expect(await tab.evaluate(() => window.__error)).toContain('Skip for now');
          expect(await tab.evaluate(() => window.__registered)).toEqual([]);

          // Pick two folders: the open one, then atlas.
          await tab.getByRole('button', { name: 'Add this folder' }).click();
          await tab.click('[data-explorer-entry="atlas"]');
          await tab.waitForFunction(() => document.querySelector('[data-explorer-state="ready"]') !== null);
          await tab.waitForSelector('[data-explorer-up]');
          await shot('1b-inside-atlas');

          // O9-4: the toolbar is ONE row (every control shares a line, none wraps), Up sits in the path row with Go inside the
          // path field, and "Add this folder" is the only primary button in the explorer.
          const layout = await tab.evaluate(() => {
            const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
            const bar = document.querySelector('[data-explorer-toolbar]');
            const kids = [...(bar?.querySelectorAll('button, label, fieldset') ?? [])].map(e =>
              e.getBoundingClientRect(),
            );
            const field = box('[data-explorer-path-box] input');
            const go = box('[data-explorer-path-box] button[type="submit"]');
            const up = box('[data-explorer-up]');
            const barBox = bar?.getBoundingClientRect();
            return {
              rowTops: new Set(kids.map(r => Math.round(r.top + r.height / 2))).size,
              barRight: barBox?.right ?? 0,
              lastRight: Math.max(...kids.map(r => r.right)),
              goInside: go !== undefined && field !== undefined && go.left >= field.left && go.right <= field.right,
              upBeforeField:
                up !== undefined &&
                field !== undefined &&
                up.right <= field.left &&
                Math.abs(up.top + up.height / 2 - (field.top + field.height / 2)) < 2,
              primaries: document.querySelectorAll('[data-explorer-state] [data-variant="primary"]').length,
              upHeight: up?.height ?? 0,
              barHeight: barBox?.height ?? 0,
              viewport: window.innerWidth,
            };
          });
          expect(layout.rowTops, 'the toolbar controls share one line').toBe(1);
          expect(layout.lastRight, 'nothing pokes out of the toolbar').toBeLessThanOrEqual(layout.barRight + 0.5);
          expect(layout.goInside, 'Go sits inside the path field').toBe(true);
          expect(layout.upBeforeField, 'Up sits in the path row, before the field').toBe(true);
          expect(layout.primaries, 'Add this folder is the single primary action').toBe(1);
          expect(layout.lastRight, 'the toolbar fits the viewport').toBeLessThanOrEqual(layout.viewport);
          await tab.getByRole('button', { name: 'Add this folder' }).click();
          await tab.waitForFunction(() => document.querySelectorAll('[data-projects-step-picks] li').length === 2);
          await shot('2-two-folders');

          await tab.click('[data-step-next]');
          await tab.waitForFunction(() => window.__registered.length === 2);
          expect(await tab.evaluate(() => window.__registered)).toEqual(['/home/sam', '/home/sam/atlas']);
          expect(await tab.evaluate(() => window.__memory)).toEqual({
            openLabel: 'Open your projects',
            openHref: '/d/studio-box/projects',
          });

          await tab.click('[data-step-later]');
          expect(await tab.evaluate(() => window.__skipped)).toBe(1);
          const after = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(after).toBeLessThanOrEqual(0);
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      });
});
