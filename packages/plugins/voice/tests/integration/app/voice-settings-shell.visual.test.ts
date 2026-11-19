/**
 * VOICE SETTINGS inside the REAL Settings shell (r10 S5; `fixtures/voice-settings-shell-scene.tsx`): the real app shell over
 * one fake machine, Voice's real tabs over fixed fake data, at 768, 1280 and 390 wide, light and dark.
 *
 * The rule under test is the owner's: lay out by the SETTINGS PANEL's width, never the window's. At a 768 px window the real
 * panel is only about 212 px wide (the drawer, the side column and the settings list take the rest), so nothing in the panel
 * may overflow it, every engine card is one fixed height, and every control is still a 44 px target.
 *
 * Set `FY_VOICE_SETTINGS_SHOTS_DIR` to keep `<viewport>-<scheme>-<tab>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import { ON_DEVICE_MODELS } from '../../../app/lib/stt/model-catalog.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_VOICE_SETTINGS_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-voice-settings-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/voice-settings-shell-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the voice settings scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '768', width: 768, height: 900, phone: false },
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

const open = async (viewport: Viewport, scheme: 'light' | 'dark', tab: string, query = '') => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
    colorScheme: scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  await page.goto(`${origin}/d/ws/settings/voice/${tab}?theme=studio-${scheme}${query}`);
  try {
    await page.waitForSelector('.fy-settings-page [data-setting-group], .fy-settings-page [data-testid]', {
      timeout: 8_000,
    });
  } catch (error) {
    const seen = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 600);
    throw new Error(`the Voice tab ${tab} did not draw: ${String(error)}\n${problems.join('\n')}\nON SCREEN: ${seen}`);
  }
  return { page, problems, close: async () => await context.close() };
};

/** The page scrolls inside the shell, so a shot of the whole tab is a tall window. */
const tall = async (page: Page, viewport: Viewport, height: number): Promise<void> => {
  await page.setViewportSize({ width: viewport.width, height });
};

const shoot = async (page: Page, viewport: Viewport, scheme: string, name: string): Promise<void> => {
  if (shotsDir === '') return;
  await tall(page, viewport, 6_000);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-${name}.png`), fullPage: true });
};

/** Every visible thing inside the settings panel that sticks out past its right (or left) edge. */
const overflowing = async (page: Page): Promise<readonly string[]> =>
  await page.evaluate(() => {
    const panel = document.querySelector('.fy-settings-page');
    if (panel === null) return ['no panel'];
    const edge = panel.getBoundingClientRect();
    const out: string[] = [];
    for (const element of panel.querySelectorAll<HTMLElement>('*')) {
      if (element.closest('.sr-only') !== null || element.classList.contains('sr-only')) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (getComputedStyle(element).position === 'absolute' && element.tagName === 'INPUT') continue;
      if (box.right > edge.right + 1 || box.left < edge.left - 1)
        out.push(
          `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)} ${Math.round(box.left)}..${Math.round(box.right)} vs ${Math.round(edge.left)}..${Math.round(edge.right)}`,
        );
    }
    return out.slice(0, 8);
  });

/** The vertical middle of a box: a row aligns its controls on it. */
const mid = (box: { y: number; height: number }): number => box.y + box.height / 2;

const rect = async (page: Page, selector: string) =>
  await page
    .locator(selector)
    .first()
    .evaluate(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    });

describe('Voice settings in the real Settings shell', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`${viewport.name} ${scheme}: Voice (this device) fits the panel, its engine cards are one height and its controls are 44 px`, async () => {
        const { page, problems, close } = await open(viewport, scheme, 'voice');
        try {
          await page.waitForSelector('.fy-engine-card');
          // The list is short (the device's default, two more, the browser); every engine is one press away.
          expect(await page.locator('.fy-engine-card').count()).toBe(4);
          await shoot(page, viewport, scheme, 'voice');
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.locator('[data-engine-show-all]').click();
          const panel = await rect(page, '.fy-settings-page');
          // The panel is what the layout follows: report it, and hold the 768 case to the owner's measured ~212 px.
          if (viewport.name === '768') {
            expect(panel.width).toBeGreaterThan(150);
            expect(panel.width).toBeLessThan(300);
          }
          expect(await overflowing(page), 'nothing sticks out of the panel').toEqual([]);
          // No setting's name is squeezed into a sliver beside its control: every name has room for about two words.
          expect(
            await page.evaluate(() =>
              [
                ...document.querySelectorAll<HTMLElement>(
                  '.fy-settings-page [data-setting-row] > div:first-child > span:first-child',
                ),
              ]
                .filter(label => label.getBoundingClientRect().width < 110 && label.getBoundingClientRect().width > 0)
                .map(label => label.textContent?.slice(0, 30) ?? ''),
            ),
            'no setting name is squeezed',
          ).toEqual([]);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
            'no sideways scroll',
          ).toBeLessThanOrEqual(0);

          // The engine cards: every one the same fixed height, none wider than the panel.
          const cards = await page
            .locator('.fy-engine-card')
            .evaluateAll(nodes =>
              nodes.map(node => node.getBoundingClientRect()).map(r => [Math.round(r.width), Math.round(r.height)]),
            );
          expect(cards.length).toBe(ON_DEVICE_MODELS.length + 1);
          expect(new Set(cards.map(card => card[1]))).toEqual(new Set([132]));
          for (const [width] of cards) expect(width).toBeLessThanOrEqual(panel.width + 1);
          // Nothing inside a card is clipped by it: every part of a card sits within the card's own edge.
          expect(
            await page.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>('.fy-engine-card')].flatMap(card => {
                const edge = card.getBoundingClientRect();
                return [...card.querySelectorAll<HTMLElement>('.fy-engine-body *')]
                  .filter(part => part.getBoundingClientRect().width > 0 && getComputedStyle(part).display !== 'none')
                  .filter(part => part.getBoundingClientRect().right > edge.right + 1)
                  .map(part => `${card.dataset.engine}: ${part.className}`);
              }),
            ),
            'no part of a card is clipped',
          ).toEqual([]);

          // After dictating, a row of cards that stack when the PANEL is narrow, never because the window is.
          const choices = await page
            .locator('[data-after-dictating] .fy-cc__card')
            .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
          expect(choices.length).toBe(2);
          if (panel.width >= 520) expect(choices[0]).toBe(choices[1]);
          else expect(choices[1]).toBeGreaterThan(choices[0] ?? 0);

          // The device keys: ONE row of key + Save + Test + Remove, wrapping under the key when the panel is narrow.
          const key = await rect(page, '[data-device-key="groq"] input');
          const save = await rect(page, '[data-device-key="groq"] button[type="submit"]');
          const test = await rect(page, '[data-device-key="groq"] button[aria-label="Test the Groq key"]');
          expect(key.width).toBeLessThanOrEqual(36 * 16 + 1);
          for (const button of [save, test]) expect(button.height).toBeGreaterThanOrEqual(44);
          expect(Math.abs(save.y - test.y)).toBeLessThanOrEqual(2);
          if (panel.width >= 700) expect(Math.abs(mid(key) - mid(save))).toBeLessThanOrEqual(2);
          else expect(save.y).toBeGreaterThanOrEqual(key.y + key.height - 1);
          expect(problems).toEqual([]);
          await shoot(page, viewport, scheme, 'voice-all-engines');
        } finally {
          await close();
        }
      });

      it(`${viewport.name} ${scheme}: Voice clean-up and Speed-ups fit the panel`, async () => {
        for (const tab of ['voice-cleanup', 'speedups']) {
          const { page, problems, close } = await open(viewport, scheme, tab);
          try {
            expect(await overflowing(page), `${tab}: nothing sticks out of the panel`).toEqual([]);
            if (tab === 'speedups') {
              // Shot 09: the key, Save and Test sit in one row at a width that holds them, in one height.
              const panel = await rect(page, '.fy-settings-page');
              const key = await rect(page, '[data-speedup="groq"] input');
              const save = await rect(page, '[data-speedup="groq"] button[type="submit"]');
              const test = await rect(page, '[data-speedup="groq"] button[aria-label="Test the Groq key"]');
              expect(save.height).toBeGreaterThanOrEqual(44);
              expect(test.height).toBeGreaterThanOrEqual(44);
              expect(key.width).toBeLessThanOrEqual(36 * 16 + 1);
              if (panel.width >= 700) expect(Math.abs(mid(key) - mid(save))).toBeLessThanOrEqual(2);
            }
            expect(problems).toEqual([]);
            await shoot(page, viewport, scheme, tab);
          } finally {
            await close();
          }
        }
      });
    }

  it('the Voice nav lists the device tab under This device and the clean-up tab under the machine', async () => {
    const { page, close } = await open(VIEWPORTS[1], 'light', 'voice');
    try {
      const nav = page.locator('nav[aria-label="Plugin settings"]');
      const text = (await nav.innerText()).replace(/\s+/g, ' ');
      // Two headed blocks: the browser's own, then the machine's (r10 S1), and Voice sits in the first.
      expect(text).toMatch(/JUST THIS DEVICE.*Voice.*WORKSHOP-HOST · EVERY DEVICE/i);
      await page.evaluate(() => {
        for (const each of document.querySelectorAll<HTMLDetailsElement>('nav details')) each.open = true;
      });
      expect(await nav.locator('a', { hasText: 'Voice clean-up' }).count()).toBe(1);
      expect(await nav.locator('a', { hasText: /^Voice$/ }).count()).toBe(1);
    } finally {
      await close();
    }
  });

  it('dictation off shows the switch and one quiet line, with the engine list gone', async () => {
    const { page, close } = await open(VIEWPORTS[1], 'light', 'voice', '&off=1');
    try {
      expect(await page.locator('.fy-engine-card').count()).toBe(0);
      expect(await page.locator('[data-voice-settings]').innerText()).toContain('Dictation is disabled');
    } finally {
      await close();
    }
  });
});
