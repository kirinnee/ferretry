/**
 * R10 S11: THE RUNTIMES SETTINGS TABS INSIDE THE REAL SETTINGS SHELL (`?real=runtimes`: the real tab bodies over fake reads,
 * `fixtures/settings-shell-scene.tsx`). The Settings panel is far narrower than the window (212px at 768, 264 at 820, 724 at
 * 1280), so every layout choice follows the PANEL, never the viewport; nothing scrolls sideways at any of them.
 *
 * Set `FY_SETTINGS_SHELL_SHOTS_DIR` to keep `<viewport>-<tab>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(40_000);

const shotsDir = process.env.FY_SETTINGS_SHELL_SHOTS_DIR ?? '';
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-settings-runtimes-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(import.meta.dir, 'fixtures/settings-shell-scene.tsx'),
    ],
    { cwd: import.meta.dir, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the settings shell scene did not build (${code}):\n${stderr}\n${stdout}`);
  const built = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(built.css, 'utf8');
  const js = await readFile(built.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '768-light', width: 768, height: 900, phone: false, scheme: 'light' },
  { name: '768-dark', width: 768, height: 900, phone: false, scheme: 'dark' },
  { name: '1280-light', width: 1_280, height: 900, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 900, phone: false, scheme: 'dark' },
] as const;

/** The five tabs: the path under /d/ws/settings and one thing each must draw. */
const TABS = [
  { id: 'runtimes', path: 'runtimes/runtimes', ready: '[data-runtimes-tab]' },
  { id: 'profiles', path: 'runtimes/profiles', ready: '[data-profiles-tab], [data-profile-row]' },
  { id: 'model-sets', path: 'runtimes/model-sets', ready: '[data-component-row]' },
  { id: 'agents', path: 'runtimes/agents', ready: '[data-agents-tab]' },
  { id: 'transfer', path: 'runtimes/transfer', ready: '[data-setup-transfer]' },
] as const;

describe('Settings shell: the Runtimes tabs (S11)', () => {
  for (const variant of VARIANTS)
    for (const tabInfo of TABS)
      it(`${variant.name}: ${tabInfo.id} draws in the panel and does not scroll sideways`, async () => {
        const context = await browser.newContext({
          viewport: { width: variant.width, height: variant.height },
          deviceScaleFactor: variant.phone ? 2 : 1,
          hasTouch: variant.phone,
          isMobile: variant.phone,
          colorScheme: variant.scheme,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        tab.setDefaultTimeout(8_000);
        const problems: string[] = [];
        tab.on('pageerror', error => problems.push(error.message));
        try {
          await tab.goto(`${origin}/d/ws/settings/${tabInfo.path}?real=runtimes&theme=studio-${variant.scheme}`);
          await tab.waitForSelector(tabInfo.ready, { timeout: 8_000 }).catch(async () => {
            const seen = (
              await tab
                .locator('body')
                .innerText()
                .catch(() => '')
            ).slice(0, 800);
            throw new Error(`${tabInfo.id} did not draw ${tabInfo.ready}\n${problems.join('\n')}\nON SCREEN: ${seen}`);
          });
          await tab.waitForTimeout(400);
          const offenders = await tab.evaluate(() => {
            const root = document.querySelector('[data-machine-settings]') as HTMLElement;
            const edge = root.getBoundingClientRect().right;
            const out: string[] = [];
            for (const el of root.querySelectorAll<HTMLElement>('*')) {
              const style = getComputedStyle(el);
              if (style.position === 'absolute' || el.closest('.sr-only') !== null) continue;
              const box = el.getBoundingClientRect();
              if (box.width === 0 || box.height === 0) continue;
              if (box.right > edge + 1)
                out.push(
                  `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(box.right)} edge=${Math.round(edge)} ${(el.textContent ?? '').slice(0, 30)}`,
                );
            }
            return out.slice(0, 12);
          });
          expect(offenders, `${variant.name} ${tabInfo.id}: nothing runs past the panel`).toEqual([]);
          if (shotsDir !== '') {
            if (variant.phone) await tab.setViewportSize({ width: variant.width, height: 2400 });
            await tab.screenshot({ path: join(shotsDir, `${variant.name}-${tabInfo.id}.png`) });
          }
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      });
});

/** The pages a row opens: the profile editor (a two-column workspace on a wide panel) and a model set. */
const DETAILS = [
  {
    id: 'profile-editor',
    path: 'runtimes/profiles',
    row: '[data-profile-row="Default"]',
    ready: '[data-profile-editor]',
  },
  {
    id: 'model-set',
    path: 'runtimes/model-sets',
    row: '[data-component-row]',
    ready: '[data-components-page="detail"]',
  },
] as const;

describe('Settings shell: the Runtimes pages a row opens (S11)', () => {
  for (const variant of VARIANTS)
    for (const detail of DETAILS)
      it(`${variant.name}: ${detail.id} fits the panel`, async () => {
        const context = await browser.newContext({
          viewport: { width: variant.width, height: variant.height },
          deviceScaleFactor: variant.phone ? 2 : 1,
          hasTouch: variant.phone,
          isMobile: variant.phone,
          colorScheme: variant.scheme,
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        tab.setDefaultTimeout(8_000);
        try {
          await tab.goto(`${origin}/d/ws/settings/${detail.path}?real=runtimes&theme=studio-${variant.scheme}`);
          await tab.waitForSelector(detail.row);
          await tab.locator(detail.row).first().click();
          await tab.waitForSelector(detail.ready);
          await tab.waitForTimeout(400);
          if (shotsDir !== '') {
            if (variant.phone) await tab.setViewportSize({ width: variant.width, height: 2600 });
            await tab.screenshot({ path: join(shotsDir, `${variant.name}-${detail.id}.png`) });
          }
          const offenders = await tab.evaluate(() => {
            const root = document.querySelector('[data-machine-settings]') as HTMLElement;
            const edge = root.getBoundingClientRect().right;
            const out: string[] = [];
            for (const el of root.querySelectorAll<HTMLElement>('*')) {
              if (getComputedStyle(el).position === 'absolute' || el.closest('.sr-only') !== null) continue;
              const box = el.getBoundingClientRect();
              if (box.width > 0 && box.height > 0 && box.right > edge + 1)
                out.push(
                  `${el.tagName.toLowerCase()} ${Math.round(box.right)}>${Math.round(edge)} ${(el.textContent ?? '').slice(0, 30)}`,
                );
            }
            return out.slice(0, 8);
          });
          expect(offenders, `${variant.name} ${detail.id}`).toEqual([]);
          if (detail.id === 'profile-editor') {
            // The two-column workspace follows the PANEL: the library sits beside the contents from 640px of panel, and under
            // 640px the library is out of the way (Add opens it) however wide the window is.
            const shape = await tab.evaluate(() => {
              const panel = (document.querySelector('[data-machine-settings]') as HTMLElement).getBoundingClientRect()
                .width;
              const library = document.querySelector('[data-profile-library]') as HTMLElement;
              const contents = document.querySelector('[data-profile-box]') as HTMLElement;
              const add = document.querySelector('[data-profile-pick]') as HTMLElement;
              return {
                panel,
                libraryShown: getComputedStyle(library).display !== 'none',
                sideBySide:
                  getComputedStyle(library).display !== 'none' &&
                  library.getBoundingClientRect().right <= contents.getBoundingClientRect().left + 1,
                addShown: getComputedStyle(add).display !== 'none',
              };
            });
            const wide = shape.panel >= 640;
            expect(shape.libraryShown, `panel ${shape.panel}px`).toBe(wide);
            expect(shape.sideBySide, `panel ${shape.panel}px`).toBe(wide);
            expect(shape.addShown, `panel ${shape.panel}px`).toBe(!wide);
          }
        } finally {
          await context.close();
        }
      });
});
