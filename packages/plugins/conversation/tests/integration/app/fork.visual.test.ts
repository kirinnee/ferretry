/**
 * FORK INTO A NEW FERRET…, in a real browser over fake data (`fixtures/fork-scene.tsx`): the header Actions menu carrying the
 * row the REAL `ForkRowPanel` offers, and the REAL `ForkDialog` in its three states (the picker, a refused fork's own
 * sentence, the made fork), at a phone (390) and a desktop (1440), light and dark, in the default look (Studio) and the roundest
 * (Gen Z). Every state must stay inside the screen, be a comfortable target on a phone, and keep its content inside the curve
 * of the box it sits in (the round-safe rule).
 *
 * Set `FY_FORK_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>-<state>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
/** Ferrets' stylesheet for the header menu, read as a file and never imported: Conversation reaches another package only through its contract. */
const MENU_STYLES = join(packageRoot, '../../../../../core/ferrets/app/features/header/ferret-actions.css');
const shotsDir = process.env.FY_FORK_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-fork-'));
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/fork-scene.tsx'], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the fork scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const menu = await readFile(MENU_STYLES, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${menu}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
] as const;
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;

const REFUSAL =
  'the conversation was written by Codex 0.99.0, a rollout format Ferretry has not tested, so it was not forked';

interface State {
  readonly name: string;
  readonly query: string;
  /** What must hold once the scene has drawn and `act` has run. */
  readonly check: (page: Page, phone: boolean) => Promise<void>;
  readonly act?: (page: Page) => Promise<void>;
}

/** The box is wholly on the screen: nothing cut at an edge, which a dialog on a phone is most likely to do. */
const onScreen = async (page: Page, selector: string, width: number): Promise<void> => {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, selector).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
};

/** The buttons are wholly on the screen, whatever the form above them holds: a person retrying a refusal must reach them. */
const buttonsReachable = async (page: Page): Promise<void> => {
  const height = page.viewportSize()?.height ?? 0;
  for (const button of await page.locator('.fy-action-form__foot button').all()) {
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(height);
  }
};

const STATES: readonly State[] = [
  {
    name: 'menu',
    query: 'scene=menu',
    check: async (page, phone) => {
      const row = page.locator('[data-ferret-action-item="fork"]');
      await expect(row.count()).resolves.toBe(1);
      expect(await row.textContent()).toContain('Fork into a new ferret…');
      if (phone) expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    },
  },
  {
    name: 'form',
    query: 'scene=form',
    check: async (page, phone) => {
      // The latest thing said is the one picked, and what was said is listed newest first.
      expect(await page.locator('[data-fork-picker] input:checked').getAttribute('value')).toBe('70.0');
      expect(await page.locator('.fy-fork-pick__text').first().textContent()).toBe('Great. What is left?');
      if (phone) {
        for (const selector of ['.fy-fork-pick', '[data-action-submit]', '.fy-segmented__option']) {
          const box = await page.locator(selector).first().boundingBox();
          expect(box?.height ?? 0, selector).toBeGreaterThanOrEqual(36);
        }
      }
      await onScreen(page, '[data-fork-dialog]', phone ? 390 : 1_440);
      await buttonsReachable(page);
    },
  },
  {
    name: 'refused',
    query: 'scene=form&state=refused',
    act: async page => {
      await page.locator('[data-action-submit]').click();
      await page.waitForSelector('[data-fork-form] [role="alert"]');
    },
    check: async page => {
      expect(await page.locator('[data-fork-form] [role="alert"]').textContent()).toBe(REFUSAL);
      // The sentence and the buttons stay in view even when the fields above them need the dialog's whole height.
      await buttonsReachable(page);
      const alert = await page.locator('[data-fork-form] [role="alert"]').boundingBox();
      expect((alert?.y ?? 0) + (alert?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
    },
  },
  {
    name: 'done',
    query: 'scene=form&state=done',
    act: async page => {
      await page.locator('[data-action-submit]').click();
      await page.waitForSelector('[data-fork-done]');
    },
    check: async page => {
      const text = await page.locator('[data-fork-done]').textContent();
      expect(text).toContain('Forked into a new ferret');
      expect(text).toContain('fork/olive-01234567');
      expect(text).toContain('2 attachments came with it');
      expect(await page.getByRole('button', { name: 'Open it' }).count()).toBe(1);
    },
  },
];

for (const look of LOOKS) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      describe(`fork: ${look.style} ${viewport.name} ${scheme}`, () => {
        for (const state of STATES) {
          it(state.name, async () => {
            const context = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              deviceScaleFactor: viewport.phone ? 2 : 1,
              hasTouch: viewport.phone,
              isMobile: viewport.phone,
              colorScheme: scheme,
              reducedMotion: 'reduce',
            });
            try {
              const origin = server?.url.origin ?? '';
              await context.route('**/*', async route =>
                new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
              );
              const page = await context.newPage();
              page.setDefaultTimeout(8_000);
              await page.goto(
                `${origin}/?theme=${look.palette}-${scheme}&motion=reduced&${state.query}${viewport.phone ? '&compact=1' : ''}`,
              );
              await page.evaluate(style => document.documentElement.setAttribute('data-style', style), look.style);
              await page.waitForSelector(state.name === 'menu' ? '[data-ferret-actions-menu]' : '[data-fork-form]');
              await page.evaluate(async () => await document.fonts.ready);
              await state.act?.(page);
              await page.waitForTimeout(300);
              await state.check(page, viewport.phone);
              if (shotsDir !== '')
                await page.screenshot({
                  path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}-${state.name}.png`),
                  fullPage: true,
                });
              const misses = await roundSafeMisses(page);
              expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
            } finally {
              await context.close();
            }
          });
        }
      });
    }
  }
}
