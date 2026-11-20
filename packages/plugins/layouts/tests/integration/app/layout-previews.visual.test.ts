/**
 * THE LAYOUT PREVIEWS in a real browser over fake data (`fixtures/layout-previews-scene.tsx`): each choice and the
 * navigation list draw a 160 x 100 frame, the movement shows before then after, motion off shows the final frame only and
 * runs nothing, a hidden tab stops them, and nothing makes the page scroll sideways.
 *
 * Set `FY_LAYOUT_PREVIEWS_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Locator, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_PREVIEWS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-layout-previews-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/layout-previews-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the layout previews scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 900, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 900, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 900, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant, query = '') => {
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
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}${query}`);
  await tab.waitForSelector('[data-setting-preview]');
  await nudge(tab);
  return { tab, problems, close: async () => await context.close() };
};

/** Jump every running animation to `ms` into its loop and hold it there, so a frame is the same on every run. */
const seek = async (tab: Page, ms: number): Promise<void> => {
  await tab.evaluate(at => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = at;
    }
  }, ms);
};

/**
 * The frames REST on the chosen value and play once when it changes (compose/setting-preview), so each choice is given
 * one change and the way back, and every movement is then held at its start so a frame is the same on every run.
 */
const nudge = async (tab: Page): Promise<void> => {
  // A change and then the way back: every choice ends on the value it started on, having played one movement.
  const names = await tab.evaluate(() => [
    ...new Set([...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(input => input.name)),
  ]);
  for (const name of names) {
    const radios = tab.locator(`input[type="radio"][name="${name}"]`);
    const homeValue = await radios.evaluateAll(
      nodes => (nodes as HTMLInputElement[]).find(n => n.checked)?.value ?? null,
    );
    const awayValue = await radios.evaluateAll(
      nodes => (nodes as HTMLInputElement[]).find(n => !n.checked && !n.disabled)?.value ?? null,
    );
    if (homeValue === null || awayValue === null) continue;
    await tab
      .locator(`input[type="radio"][name="${name}"][value="${awayValue}"]`)
      .first()
      .locator('xpath=ancestor::label')
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await tab
      .locator(`input[type="radio"][name="${name}"][value="${homeValue}"]`)
      .first()
      .locator('xpath=ancestor::label')
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await seek(tab, 0);
  }
  const switches = tab.locator('[role="switch"], button[aria-pressed]');
  for (let index = 0; index < (await switches.count()); index += 1) {
    await switches
      .nth(index)
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await switches
      .nth(index)
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await seek(tab, 0);
  }
};

const previewOf = (tab: Page, row: string): Locator =>
  tab.locator(`[data-setting-row="${row}"] [data-setting-preview]`);

const shot = async (locator: Locator, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await locator.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const ROWS = ['Navigation', 'Second column', 'Density', 'Navigation items'] as const;
const LOOP = 1_400;

describe('the layout previews', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: every row has a 160 x 100 preview, the movement plays, and the page does not scroll sideways`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        for (const row of ROWS) {
          const box = await previewOf(tab, row).first().boundingBox();
          expect(Math.round(box?.width ?? 0), row).toBe(160);
          expect(Math.round(box?.height ?? 0), row).toBe(100);
        }
        const overflow = await tab.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
        // A 3-frame strip per row: the start, the middle of the change, the settled frame.
        for (const row of ROWS) {
          const preview = previewOf(tab, row).first();
          await preview.scrollIntoViewIfNeeded();
          const slug = row.toLowerCase().replaceAll(' ', '-');
          // The choice rows keep the first frame underneath while the second fades in over it from 18% to 54%
          // (setting-preview.css `fy-sp-after`): 36% is the middle of that fade. The list slides between 18% and 64%.
          const middle = row === 'Navigation items' ? 0.4 : 0.36;
          for (const [frame, at] of [
            ['f1', 0.05],
            ['f2', middle],
            ['f3', 0.6],
          ] as const) {
            await seek(tab, LOOP * at);
            await shot(preview, variant, `${slug}-${frame}`);
          }
        }
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: the navigation list slides its lifted row into place and the page shot is kept`, async () => {
      const { tab, close } = await open(variant);
      try {
        const lifted = previewOf(tab, 'Navigation items').first().locator('.fy-ls-nrow[data-role="lift"]');
        await seek(tab, 0);
        const start = await lifted.boundingBox();
        await seek(tab, LOOP * 0.6);
        const end = await lifted.boundingBox();
        expect((end?.y ?? 0) - (start?.y ?? 0), 'the row moves down two places').toBeGreaterThan(20);
        // The group, not the page: the app's own scroller clips a full-page capture.
        await tab.setViewportSize({ width: variant.width, height: 4_000 });
        await shot(tab.locator('[data-setting-group="Navigation"]'), variant, 'group');
      } finally {
        await close();
      }
    });

    it(`${variant.name}: with motion reduced it shows the final frame only and runs nothing`, async () => {
      const { tab, close } = await open(variant, '&motion=reduced');
      try {
        expect(await tab.evaluate(() => document.getAnimations().length)).toBe(0);
        expect(await tab.locator('[data-setting-preview]').first().getAttribute('data-sp-state')).toBe('still');
        expect(await tab.locator('.fy-sp__layer--before').count()).toBe(0);
        const lifted = previewOf(tab, 'Navigation items').first().locator('.fy-ls-nrow[data-role="lift"]');
        expect(await lifted.evaluate(node => getComputedStyle(node).transform)).toBe('none');
        await shot(previewOf(tab, 'Navigation').first(), variant, 'reduced-motion');
      } finally {
        await close();
      }
    });
  }

  it('hiding a Navigation item plays once and the frame is at rest 3 s later with nothing still running', async () => {
    const { tab, close } = await open(VARIANTS[0]);
    try {
      const frame = previewOf(tab, 'Navigation items').first();
      // Let every frame finish the play the setup gave it, so this one is measured from its own start.
      await tab.waitForFunction(
        () => document.querySelector('[data-setting-preview][data-sp-state="playing"]') === null,
      );
      await tab.locator('button[aria-label^="Hide "]').first().click();
      expect(await frame.getAttribute('data-sp-state')).toBe('playing');
      // The list scene switches its layers' own animation off, so only the primitive's clock can end this play.
      await tab.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-setting-row="Navigation items"] [data-setting-preview]')].every(
            node => node.getAttribute('data-sp-state') === 'still',
          ),
        undefined,
        { timeout: LOOP + 2_000 },
      );
      await tab.waitForTimeout(3_000 - LOOP > 0 ? 3_000 - LOOP : 0);
      expect(await frame.getAttribute('data-sp-state')).toBe('still');
      expect(
        await frame.evaluate(node => node.getAnimations({ subtree: true }).length),
        'nothing in the frame is still animating after it rests',
      ).toBe(0);
      // Frames scrolled off-screen hold their play (paused, by design); none anywhere is RUNNING.
      expect(
        await tab.evaluate(
          () => document.getAnimations().filter(animation => animation.playState === 'running').length,
        ),
        'nothing on the page is running',
      ).toBe(0);
    } finally {
      await close();
    }
  });

  it('a hidden tab pauses every loop', async () => {
    const { tab, close } = await open(VARIANTS[0]);
    try {
      await tab.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await tab.waitForFunction(
        () => document.querySelector('[data-setting-preview][data-sp-state="paused"]') !== null,
      );
      const states = await tab.evaluate(() => document.getAnimations().map(animation => animation.playState));
      expect(states.length).toBeGreaterThan(0);
      expect(states.every(state => state === 'paused')).toBe(true);
    } finally {
      await close();
    }
  });
});
