/**
 * THE COMPOSER "+" MENU AND THE FULL-SCREEN IMAGE VIEWER IN A REAL BROWSER.
 *
 * WHY THIS TIER. Both are about pixels and gestures the DOM tier cannot see: a sheet that sits on the
 * bottom edge, a popover that must NOT cover the text being typed, rows that are big enough for a
 * thumb, a lightbox that fills the screen, and a menu that must not flicker when the phone keyboard
 * resizes the window. They are driven on the shipped `Composer` and the app's whole stylesheet (see
 * `composer-editor.visual.test.ts` for how the scene is built).
 *
 * IT IS ALSO THE EVIDENCE DRIVER. Set `COMPOSER_EVIDENCE_DIR` to an absolute directory outside the
 * repository and the last journey writes the menu and the viewer at phone 390/412 and desktop 1440,
 * light and dark.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';
import { type ComposerSceneServer, serveComposerScene } from './support/composer-scene.ts';

const evidenceDir = process.env.COMPOSER_EVIDENCE_DIR ?? null;

const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
const phone = (width: number) =>
  ({
    viewport: { width, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  }) as const;

const MENU = '[data-testid="composer-add-menu"]';
const VIEWER = '[data-testid="image-viewer"]';
const PLUS = 'button[data-composer-attach]';

let browser: Browser;
let server: ComposerSceneServer;

beforeAll(async () => {
  server = await serveComposerScene();
  browser = await sharedChromium();
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

interface Options {
  readonly theme?: string;
  readonly width?: number;
  readonly params?: Record<string, string>;
}

const open = async ({ theme = 'studio-light', width, params = {} }: Options = {}) => {
  const context = await browser.newContext(width === undefined ? DESKTOP : phone(width));
  const page = await context.newPage();
  await page.route(/^(?!http:\/\/127\.0\.0\.1:)/u, route => route.abort());
  await page.route(/\/v1\//u, route => route.abort());
  const query = new URLSearchParams({
    editor: 'off',
    theme,
    host: '1',
    ...(width === undefined ? {} : { compact: '1' }),
    ...params,
  });
  await page.goto(`${server.url}?${query.toString()}`);
  await page.waitForSelector('[data-composer-send]');
  return { page, close: () => context.close() };
};

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} has no box`);
  return found;
};

/** A real PNG a chip can hold, drawn by the page itself so the test needs no image codec. */
const picture = async (page: Page, name: string, hue: number) => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.from(
    await page.evaluate(
      async ([label, h]) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1200;
        canvas.height = 800;
        const context = canvas.getContext('2d') as CanvasRenderingContext2D;
        context.fillStyle = `hsl(${h} 65% 50%)`;
        context.fillRect(0, 0, 1200, 800);
        context.fillStyle = '#fff';
        context.font = '90px sans-serif';
        context.fillText(String(label), 60, 720);
        return canvas.toDataURL('image/png').split(',')[1] as string;
      },
      [name, hue] as const,
    ),
    'base64',
  ),
});

const addPictures = async (page: Page, names: readonly string[]) => {
  const files = [];
  for (const [at, name] of names.entries()) files.push(await picture(page, name, 20 + at * 90));
  await page.locator('input[type="file"][accept="image/*"]:not([capture])').setInputFiles(files);
  await page.waitForSelector(`[aria-label="Open ${names[names.length - 1]}"]`);
};

const evidence = async (page: Page, name: string) => {
  if (evidenceDir === null) return;
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: join(evidenceDir, `${name}.png`) });
};

describe('the composer add menu', () => {
  test('on a desktop it is a labelled popover above the composer and never covers the typed text', async () => {
    const scene = await open({ params: { draft: 'a message that must stay readable while the menu is open' } });
    try {
      await scene.page.locator(PLUS).click();
      await scene.page.waitForSelector(MENU);
      expect(await scene.page.locator(MENU).getAttribute('data-variant')).toBe('popover');

      const rows = scene.page.locator(`${MENU} [role="menuitem"]`);
      expect(await rows.allTextContents()).toEqual([
        'Photos & screenshotsFrom your gallery',
        'FilesDocuments, logs, anything',
        'Share locationSend where you are, with a map',
      ]);
      for (const height of await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))) {
        expect(height).toBeGreaterThanOrEqual(44);
      }

      const panel = await box(scene.page, `${MENU} .fy-add-menu`);
      const field = await box(scene.page, '.fy-composer textarea');
      expect(panel.y + panel.height).toBeLessThanOrEqual(field.y);
      const plus = await box(scene.page, PLUS);
      expect(Math.abs(panel.x - plus.x)).toBeLessThan(16);

      await scene.page.keyboard.press('Escape');
      await scene.page.waitForSelector(MENU, { state: 'detached' });
      expect(await scene.page.evaluate(() => document.activeElement?.hasAttribute('data-composer-attach'))).toBe(true);
    } finally {
      await scene.close();
    }
  }, 60_000);

  test('on a phone it is a bottom sheet with a Take photo row, big targets, and a scrim that closes it', async () => {
    const scene = await open({ width: 390, theme: 'studio-dark' });
    try {
      await scene.page.locator(PLUS).tap();
      await scene.page.waitForSelector(MENU);
      expect(await scene.page.locator(MENU).getAttribute('data-variant')).toBe('sheet');
      expect(await scene.page.locator(`${MENU} [role="menuitem"]`).count()).toBe(4);
      expect(await scene.page.locator(`${MENU} [role="menuitem"]`).first().textContent()).toContain(
        'Photos & screenshots',
      );
      expect(await scene.page.locator(`${MENU}`).textContent()).toContain('Take photo');

      // The sheet slides up: measure once it has docked to the bottom edge, not after a fixed pause.
      await scene.page.waitForFunction(selector => {
        const panel = document.querySelector(selector);
        return panel !== null && Math.round(panel.getBoundingClientRect().bottom) === window.innerHeight;
      }, `${MENU} .fy-add-menu`);
      const panel = await box(scene.page, `${MENU} .fy-add-menu`);
      const viewport = scene.page.viewportSize();
      expect(panel.x).toBeLessThanOrEqual(1);
      expect(panel.width).toBeGreaterThanOrEqual(388);
      expect(Math.round(panel.y + panel.height)).toBe(viewport?.height ?? -1);
      for (const height of await scene.page
        .locator(`${MENU} [role="menuitem"], ${MENU} button:has-text("Cancel")`)
        .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))) {
        expect(height).toBeGreaterThanOrEqual(44);
      }

      await scene.page.touchscreen.tap(195, 120);
      await scene.page.waitForSelector(MENU, { state: 'detached' });
    } finally {
      await scene.close();
    }
  }, 60_000);

  test('does not flicker: one tap shows one menu that survives resizes and scrolls', async () => {
    const scene = await open({ width: 412, params: { layout: 'chat' } });
    try {
      await scene.page.evaluate(() => {
        const win = window as unknown as { __menuAdded: number };
        win.__menuAdded = 0;
        new MutationObserver(records => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node instanceof Element && node.matches('[data-testid="composer-add-menu"]')) win.__menuAdded += 1;
            }
          }
        }).observe(document.body, { childList: true, subtree: true });
      });
      await scene.page.locator(PLUS).tap();
      await scene.page.waitForSelector(MENU);
      // The keyboard going away resizes the window; the page may also scroll.
      await scene.page.setViewportSize({ width: 412, height: 520 });
      await scene.page.evaluate(() => window.dispatchEvent(new Event('scroll')));
      await scene.page.setViewportSize({ width: 412, height: 844 });
      await scene.page.waitForTimeout(400);
      expect(await scene.page.locator(MENU).count()).toBe(1);
      expect(await scene.page.evaluate(() => (window as unknown as { __menuAdded: number }).__menuAdded)).toBe(1);
    } finally {
      await scene.close();
    }
  }, 60_000);
});

describe('the full-screen image viewer', () => {
  test('opens from a composer chip, steps with the arrow keys, and closes on Escape; ✕ removes without opening', async () => {
    const scene = await open({ params: { upload: '1' } });
    try {
      await addPictures(scene.page, ['first.png', 'second.png']);
      await scene.page.locator('[aria-label="Open first.png"]').click();
      await scene.page.waitForSelector(VIEWER);
      const viewer = await box(scene.page, VIEWER);
      expect(viewer.width).toBe(1_440);
      expect(viewer.height).toBe(900);
      const image = scene.page.locator(`${VIEWER} img`);
      await image.waitFor();
      const stage = await box(scene.page, '[data-testid="image-viewer-stage"]');
      const drawn = await image.boundingBox();
      expect(drawn).not.toBeNull();
      expect(drawn?.width).toBeLessThanOrEqual(stage.width + 1);
      expect(drawn?.height).toBeLessThanOrEqual(stage.height + 1);
      expect(await scene.page.locator(VIEWER).textContent()).toContain('1 of 2');

      await scene.page.keyboard.press('ArrowRight');
      await expect(scene.page.locator(VIEWER).textContent()).resolves.toContain('2 of 2');
      expect(await scene.page.locator(`${VIEWER} a[download]`).getAttribute('download')).toBe('second.png');
      await scene.page.keyboard.press('Escape');
      await scene.page.waitForSelector(VIEWER, { state: 'detached' });

      await scene.page.locator('[aria-label="Remove first.png"]').click();
      expect(await scene.page.locator(VIEWER).count()).toBe(0);
      expect(await scene.page.locator('[aria-label="Open first.png"]').count()).toBe(0);
      expect(await scene.page.locator('[aria-label="Open second.png"]').count()).toBe(1);
    } finally {
      await scene.close();
    }
  }, 60_000);

  test('opens from a message picture, zooms with the wheel and pans, and fits again on double click', async () => {
    const scene = await open({ params: { messages: '3' } });
    try {
      await scene.page.waitForFunction(() => document.querySelectorAll('[data-scene-message] img').length === 3);
      await scene.page.locator('[aria-label="Expand photo-1.png"], [aria-label^="Expand"]').first().click();
      await scene.page.waitForSelector(VIEWER);
      const transform = () =>
        scene.page.locator(`${VIEWER} img`).evaluate(node => (node as HTMLElement).style.transform);
      expect(await transform()).toContain('scale(1)');
      const stage = await box(scene.page, '[data-testid="image-viewer-stage"]');
      await scene.page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
      await scene.page.mouse.wheel(0, -600);
      await scene.page.waitForFunction(() => {
        const node = document.querySelector('[data-testid="image-viewer"] img') as HTMLElement | null;
        return node !== null && !node.style.transform.includes('scale(1)');
      });
      await scene.page.mouse.down();
      await scene.page.mouse.move(stage.x + stage.width / 2 - 120, stage.y + stage.height / 2 - 40, { steps: 6 });
      await scene.page.mouse.up();
      expect(await transform()).not.toContain('translate3d(0px, 0px, 0)');
      await scene.page.mouse.dblclick(stage.x + stage.width / 2, stage.y + stage.height / 2);
      await scene.page.waitForFunction(() =>
        (document.querySelector('[data-testid="image-viewer"] img') as HTMLElement).style.transform.includes(
          'scale(1)',
        ),
      );
      await scene.page.locator('[aria-label="Next image"]').click();
      expect(await scene.page.locator(VIEWER).textContent()).toContain('2 of 3');
      await scene.page.locator('[aria-label="Close image viewer"]').click();
      await scene.page.waitForSelector(VIEWER, { state: 'detached' });
    } finally {
      await scene.close();
    }
  }, 60_000);
});

describe('evidence', () => {
  test.skipIf(evidenceDir === null)(
    'writes the menu and the viewer at phone and desktop, light and dark',
    async () => {
      for (const theme of ['studio-light', 'studio-dark']) {
        const mode = theme.endsWith('dark') ? 'dark' : 'light';
        for (const width of [390, 412, 1_440]) {
          const size = width === 1_440 ? 'desktop-1440' : `phone-${width}`;
          const options: Options = {
            theme,
            ...(width === 1_440 ? {} : { width }),
            params: { upload: '1', messages: '3', draft: 'can you look at these two screenshots before you push?' },
          };
          const scene = await open(options);
          try {
            const tap = (selector: string) =>
              width === 1_440
                ? scene.page.locator(selector).first().click()
                : scene.page.locator(selector).first().tap();
            await tap(PLUS);
            await scene.page.waitForSelector(MENU);
            await scene.page.waitForTimeout(300);
            await evidence(scene.page, `menu-${size}-${mode}`);
            await scene.page.keyboard.press('Escape');
            await scene.page.waitForSelector(MENU, { state: 'detached' });

            await addPictures(scene.page, ['login-error.png', 'dashboard.png']);
            await evidence(scene.page, `tray-${size}-${mode}`);
            await tap('[aria-label="Open login-error.png"]');
            await scene.page.waitForSelector(`${VIEWER} img`);
            await scene.page.waitForTimeout(300);
            await evidence(scene.page, `viewer-tray-${size}-${mode}`);
            await scene.page.keyboard.press('Escape');
            await scene.page.waitForSelector(VIEWER, { state: 'detached' });

            await scene.page.waitForSelector('[data-scene-message] img');
            await evidence(scene.page, `message-${size}-${mode}`);
            await tap('[data-scene-message] [aria-label^="Expand"]');
            await scene.page.waitForSelector(`${VIEWER} img`);
            await scene.page.waitForTimeout(300);
            await evidence(scene.page, `viewer-message-${size}-${mode}`);
          } finally {
            await scene.close();
          }
        }
      }
    },
    240_000,
  );
});
