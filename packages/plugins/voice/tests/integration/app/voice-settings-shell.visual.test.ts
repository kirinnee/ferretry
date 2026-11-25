/**
 * VOICE SETTINGS inside the REAL Settings shell (r10 S5; `fixtures/voice-settings-shell-scene.tsx`): the real app shell over
 * one fake machine, Voice's real tabs over fixed fake data, at 768, 1280 and 390 wide, light and dark.
 *
 * The rule under test is the owner's: lay out by the SETTINGS PANEL's width, never the window's. At a 768 px window the
 * settings list stands ABOVE the panel and the panel is at least 480 px wide (it was ~212 px between two sidebars before
 * the list was stacked), so nothing in the panel may overflow it, every engine card is one fixed height, and every
 * control is still a 44 px target.
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

type Viewport = { readonly name: string; readonly width: number; readonly height: number; readonly phone: boolean };

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
          // The browser's own voice has nothing measured: no bars at all (not three empty tracks), a plain sentence instead.
          expect(await page.locator('.fy-engine-card[data-engine="browser"] [data-option-bar]').count()).toBe(0);
          expect(await page.locator('.fy-engine-card[data-engine="browser"] .fy-engine-none').innerText()).toContain(
            'Not measured',
          );
          // Every bar that is drawn has a fill: an empty track is a bug.
          expect(
            await page.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>('.fy-engine-card [data-option-bar]')]
                .filter(
                  bar =>
                    (bar.querySelector<HTMLElement>('[data-option-bar-fill]')?.getBoundingClientRect().width ?? 0) < 1,
                )
                .map(bar => bar.textContent),
            ),
            'no empty bar',
          ).toEqual([]);
          // The four cards fill the grid evenly: rows are all the same width, so no hole is left at the end of the last one.
          const rows = await page.evaluate(() => {
            const byTop = new Map<number, number[]>();
            for (const node of document.querySelectorAll<HTMLElement>('.fy-engine-card')) {
              const r = node.getBoundingClientRect();
              byTop.set(Math.round(r.top), [...(byTop.get(Math.round(r.top)) ?? []), Math.round(r.width)]);
            }
            return [...byTop.entries()].sort((a, b) => a[0] - b[0]).map(([, widths]) => widths);
          });
          expect(
            new Set(rows.map(row => row.length)).size,
            `every row holds the same number of cards: ${JSON.stringify(rows)}`,
          ).toBe(1);
          expect(rows.length * (rows[0]?.length ?? 0)).toBe(4);
          await shoot(page, viewport, scheme, 'voice');
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.locator('[data-engine-show-all]').click();
          const panel = await rect(page, '.fy-settings-page');
          // The panel is what the layout follows: hold the 768 case to the stacked layout (list above, panel >= 480 px).
          if (viewport.name === '768') {
            expect(panel.width).toBeGreaterThanOrEqual(480);
            const nav = await rect(page, '.fy-settings-nav');
            expect(nav.y + nav.height, 'the settings list is above the panel').toBeLessThanOrEqual(panel.y + 1);
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
          expect(new Set(cards.map(card => card[1]))).toEqual(new Set([186]));
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
          // ChoiceCards stack by the GROUP's own width (480 px), which is narrower than the panel that holds it.
          const group = await rect(page, '[data-after-dictating] .fy-cc');
          if (group.width >= 480) expect(choices[0]).toBe(choices[1]);
          else expect(choices[1]).toBeGreaterThan(choices[0] ?? 0);

          // The device keys: ONE row of key + Save + Test + Remove, wrapping under the key when the panel is narrow.
          const key = await rect(page, '[data-device-key="groq"] input');
          const save = await rect(page, '[data-device-key="groq"] button[type="submit"]');
          const test = await rect(page, '[data-device-key="groq"] button[aria-label="Test the Groq key"]');
          expect(key.width).toBeLessThanOrEqual(36 * 16 + 1);
          for (const button of [save, test]) expect(button.height).toBeGreaterThanOrEqual(44);
          expect(Math.abs(save.y - test.y)).toBeLessThanOrEqual(2);
          // The row wraps by what fits, not by a panel breakpoint: at 768 (a 480+ px panel) the key and Save may share one
          // line; either they do (mid-aligned), or Save has wrapped to the line under the key.
          if (panel.width >= 700) expect(Math.abs(mid(key) - mid(save))).toBeLessThanOrEqual(2);
          else if (save.y < key.y + key.height - 1) expect(Math.abs(mid(key) - mid(save))).toBeLessThanOrEqual(2);
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

  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`${viewport.name} ${scheme}: choosing a style off "Off" with the keyboard only stages it, and Apply says what it turns on`, async () => {
        const { page, problems, close } = await open(viewport, scheme, 'voice-cleanup', '&style=off');
        try {
          const writes: string[] = [];
          page.on('request', request => {
            if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
          });
          await page.locator('[data-choice-cards] input[value="off"]').focus();
          await page.keyboard.press('ArrowRight');
          // The arrow only moved the focus: nothing is staged until Enter chooses the card.
          expect(await page.locator('[data-cleanup-staged]').count()).toBe(0);
          await page.keyboard.press('Enter');
          const staged = page.locator('[data-cleanup-staged]');
          await staged.waitFor();
          expect(await page.locator('[data-cleanup-staged-note]').innerText()).toContain('turns hosted clean-up ON');
          expect(await page.locator('[data-choice-cards] input[value="fix"]').isChecked()).toBe(true);
          for (const name of ['Apply', 'Cancel'])
            expect((await rect(page, `[data-cleanup-staged] button:text-is("${name}")`)).height).toBeGreaterThanOrEqual(
              44,
            );
          expect(await overflowing(page), 'nothing sticks out of the panel').toEqual([]);
          expect(writes).toEqual([]);
          expect(problems).toEqual([]);
          await shoot(page, viewport, scheme, 'voice-cleanup-staged');
        } finally {
          await close();
        }
      });

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

  // r11 S5 (the owner: "voice default to parakeet 110M"): a device that has never chosen an engine shows Parakeet 110M
  // selected, on a computer and on a phone; a device that chose one keeps it, even the bigger Parakeet.
  for (const viewport of [VIEWPORTS[1], VIEWPORTS[2]])
    it(`${viewport.name}: a fresh device has Parakeet 110M selected, and a stored pick is kept`, async () => {
      const device = viewport.phone ? 'phone' : 'computer';
      const fresh = await open(viewport, 'light', 'voice', `&engine=none&device=${device}`);
      try {
        await fresh.page.waitForSelector('.fy-engine-card');
        const checked = await fresh.page.evaluate(() =>
          [...document.querySelectorAll<HTMLInputElement>('.fy-engine-card input[type="radio"]')]
            .filter(radio => radio.checked)
            .map(radio => radio.closest<HTMLElement>('.fy-engine-card')?.dataset['engine'] ?? ''),
        );
        expect(checked, 'exactly the 110M card is selected').toEqual(['parakeet-tdt-110m']);
        expect(await fresh.page.locator('.fy-engine-card[data-engine="parakeet-tdt-110m"]').innerText()).toContain(
          'Parakeet 110M',
        );
      } finally {
        await fresh.close();
      }
      for (const [pick, label] of [
        ['parakeet', 'Parakeet'],
        ['sherpa-zipformer-en', 'Zipformer'],
      ] as const) {
        const stored = await open(viewport, 'light', 'voice', `&engine=${pick}&device=${device}`);
        try {
          await stored.page.waitForSelector('.fy-engine-card');
          if (pick === 'parakeet') await stored.page.getByRole('button', { name: /Show every engine/u }).click();
          const checked = await stored.page.evaluate(() =>
            [...document.querySelectorAll<HTMLInputElement>('.fy-engine-card input[type="radio"]')]
              .filter(radio => radio.checked)
              .map(radio => radio.closest<HTMLElement>('.fy-engine-card')?.dataset['engine'] ?? ''),
          );
          expect(checked, `${label} stays the pick`).toEqual([pick]);
        } finally {
          await stored.close();
        }
      }
    });

  // r11 S5 review: a device that never chose an engine dictates with its MACHINE's default (voice.yaml). When that names the
  // browser, the card shown as selected is the browser's (its audio goes to the vendor), never Parakeet 110M; and pressing
  // 110M then is a real choice that is written, even though 110M is this device's own default.
  for (const viewport of [VIEWPORTS[1], VIEWPORTS[2]])
    for (const scheme of ['light', 'dark'] as const)
      it(`${viewport.name} ${scheme}: an unset device inherits a Browser machine default, and Parakeet 110M can be chosen over it`, async () => {
        const device = viewport.phone ? 'phone' : 'computer';
        const { page, problems, close } = await open(
          viewport,
          scheme,
          'voice',
          `&engine=none&machine=browser&device=${device}`,
        );
        try {
          const checked = async (): Promise<string[]> =>
            await page.evaluate(() =>
              [...document.querySelectorAll<HTMLInputElement>('.fy-engine-card input[type="radio"]')]
                .filter(radio => radio.checked)
                .map(radio => radio.closest<HTMLElement>('.fy-engine-card')?.dataset['engine'] ?? ''),
            );
          await page.waitForSelector('.fy-engine-card');
          // The machine file is read after the first paint: wait for the browser card to be the selected one.
          await page.waitForFunction(
            () =>
              document.querySelector<HTMLInputElement>('.fy-engine-card[data-engine="browser"] input')?.checked ===
              true,
          );
          expect(await checked(), 'only the Browser card is selected').toEqual(['browser']);
          expect(await page.locator('[data-engine-section] [role="status"]').innerText()).toContain('its vendor');
          await shoot(page, viewport, scheme, 'voice-inherited-browser');
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          // Choosing 110M over the inherited Browser is written: the 110M card becomes the only one selected.
          await page
            .locator('.fy-engine-card[data-engine="parakeet-tdt-110m"] input[type="radio"]')
            .check({ force: true });
          expect(await checked(), 'only the 110M card is selected after the press').toEqual(['parakeet-tdt-110m']);
          expect(await page.locator('[data-engine-section] [role="status"]').innerText()).toContain(
            'never leaves this device',
          );
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });

  // r11 S3a: Voice's lists are the app's SelectBox, not the browser's select.
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const) {
      it(`${viewport.name} ${scheme}: "Longest reading" is a SelectBox (no native select; ${viewport.phone ? 'a centred dialog' : viewport.name === '768' ? 'a centred dialog (the panel is a narrow container)' : 'a listbox under it'}); picking saves and survives a reload`, async () => {
        const { page, problems, close } = await open(viewport, scheme, 'voice');
        try {
          expect(await page.locator('.fy-settings-page select').count(), 'no native select on the tab').toBe(0);
          const box = page.locator('#auto-read-length');
          await box.scrollIntoViewIfNeeded();
          expect(await box.getAttribute('role')).toBe('combobox');
          const before = (await box.innerText()).trim();
          expect(before).not.toBe('No limit');
          await box.click();
          await page.waitForTimeout(600);
          const open = await page.evaluate(() => {
            const panel = document.querySelector('[role="dialog"], [data-select-popover]') as HTMLElement | null;
            const at = panel?.getBoundingClientRect();
            const button = document.querySelector('#auto-read-length')?.getBoundingClientRect();
            return at === undefined || button === undefined || panel === null
              ? null
              : {
                  dialog: panel.getAttribute('role') === 'dialog',
                  gap: at.top - button.bottom,
                  above: button.top - at.bottom,
                  dx: Math.abs(at.left + at.width / 2 - innerWidth / 2),
                  dy: Math.abs(at.top + at.height / 2 - innerHeight / 2),
                  options: panel.querySelectorAll('[role="option"]').length,
                };
          });
          expect(open?.options, 'the five lengths').toBe(5);
          // A phone, or a panel narrower than 600px (the stacked 768 layout): the centred dialog. Wide: the listbox.
          const asDialog = viewport.phone || viewport.name === '768';
          expect(open?.dialog).toBe(asDialog);
          if (asDialog) {
            expect(open?.dx, 'the dialog is centred across').toBeLessThanOrEqual(8);
            expect(open?.dy, 'the dialog is centred down').toBeLessThanOrEqual(8);
          } else {
            // Under the button, or above it when the window's foot is too near.
            const near = Math.min(Math.abs(open?.gap ?? 999), Math.abs(open?.above ?? 999));
            expect(near, 'the list opens right at the button').toBeLessThanOrEqual(12);
          }
          if (shotsDir !== '')
            await page.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-longest-reading-open.png`) });
          await page.locator('[role="option"]', { hasText: 'No limit' }).click();
          expect((await box.innerText()).trim()).toBe('No limit');
          // The PERSISTED choice, not the label: the device store holds "no limit" as a null length.
          const saved = await page.evaluate(() => {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i) as string;
              if (/voice/i.test(key) && /maxSeconds/.test(localStorage.getItem(key) ?? ''))
                return JSON.parse(localStorage.getItem(key) as string) as { maxSeconds: number | null };
            }
            return null;
          });
          expect(saved?.maxSeconds, 'the device store saved "no limit" as a null length').toBeNull();
          await page.reload();
          await page.waitForSelector('#auto-read-length');
          expect((await page.locator('#auto-read-length').innerText()).trim(), 'the pick was saved').toBe('No limit');
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
    }

  // r11 S3a: the correction provider is the app's SelectBox too; its choice is a write the page saves.
  for (const viewport of VIEWPORTS.filter(each => each.name !== '768'))
    for (const scheme of ['light', 'dark'] as const) {
      it(`${viewport.name} ${scheme}: "Correction provider" is a SelectBox; picking on-device saves it, picking a hosted one stages it until Apply`, async () => {
        const { page, problems, close } = await open(viewport, scheme, 'voice');
        try {
          const box = page.locator('#stt-enhancement-provider');
          await box.scrollIntoViewIfNeeded();
          expect(await box.getAttribute('role')).toBe('combobox');
          expect((await box.innerText()).trim()).toBe('On-device word correction');
          const writes = async (): Promise<unknown[]> =>
            await page.evaluate(() => (window as unknown as { __voiceWrites: unknown[] }).__voiceWrites);
          const before = (await writes()).length;
          await box.click();
          await page.waitForTimeout(600);
          expect(
            await page.locator('[role="dialog"] [role="option"], [data-select-popover] [role="option"]').count(),
          ).toBe(3);
          // A hosted provider is staged: choosing it saves nothing until Apply.
          await page.locator('[role="option"]', { hasText: 'Groq clean-up' }).click();
          await page.locator('[data-provider-staged]').waitFor();
          expect((await writes()).length, 'a hosted choice saves nothing before Apply').toBe(before);
          await page.locator('[data-provider-staged] button:text-is("Apply")').click();
          expect((await box.innerText()).trim()).toBe('Groq clean-up');
          const applied = (await writes()).slice(before);
          expect(applied.length, 'Apply saves once').toBe(1);
          expect((applied[0] as { enhancementProvider?: string }).enhancementProvider, 'the saved provider').toBe(
            'groq',
          );
          // And back to on-device saves straight away.
          await box.click();
          await page.waitForTimeout(600);
          await page.locator('[role="option"]', { hasText: 'On-device word correction' }).click();
          const back = (await writes()).slice(before + 1);
          expect(back.length, 'on-device saves once, with no Apply').toBe(1);
          expect((back[0] as { enhancementProvider?: string }).enhancementProvider, 'the saved provider').toBe('local');
          expect((await box.innerText()).trim()).toBe('On-device word correction');
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
    }
});

// E193: the clean-up choice that cannot be picked yet ("One of your logins") is not drawn at all.
describe('the "Correction provider" list in Settings › Voice', () => {
  const E193_VIEWPORTS: readonly Viewport[] = [
    { name: '390', width: 390, height: 844, phone: true },
    { name: '1440', width: 1_440, height: 900, phone: false },
  ];
  for (const viewport of E193_VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`${viewport.name} ${scheme}: lists only the choices that work, none greyed out, no "not available yet"`, async () => {
        const { page, problems, close } = await open(viewport, scheme, 'voice');
        try {
          const box = page.locator('#stt-enhancement-provider');
          await box.scrollIntoViewIfNeeded();
          await box.click();
          await page.waitForTimeout(600);
          const options = page.locator('[role="dialog"] [role="option"], [data-select-popover] [role="option"]');
          expect(await options.allInnerTexts()).toEqual([
            'On-device word correction',
            'Groq clean-up',
            'Cerebras clean-up',
          ]);
          expect(await page.locator('[role="option"][aria-disabled="true"]').count(), 'no greyed-out choice').toBe(0);
          expect(await page.locator('body').innerText()).not.toContain('not available yet');
          if (shotsDir !== '') {
            await mkdir(shotsDir, { recursive: true });
            await page.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-correction-provider-open.png`) });
          }
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
});

// VC U12: Google's live transcriber is one more card in Settings › Voice, drawn by the same card as every engine.
describe('the Google live-words engine card in Settings › Voice', () => {
  for (const viewport of [VIEWPORTS[1], VIEWPORTS[2]])
    for (const scheme of ['light', 'dark'] as const)
      it(`${viewport.name} ${scheme}: sits in the list at the cards' height, says its size, licence and credit, and has no Accuracy bar`, async () => {
        const device = viewport.phone ? 'phone' : 'computer';
        const { page, problems, close } = await open(viewport, scheme, 'voice', `&device=${device}`);
        try {
          await page.waitForSelector('.fy-engine-card');
          await page.getByRole('button', { name: /Show every engine/u }).click();
          const card = page.locator('.fy-engine-card[data-engine="google-audio-transcriber"]');
          await card.scrollIntoViewIfNeeded();
          const parakeet = page.locator('.fy-engine-card[data-engine="parakeet"]');
          expect((await card.boundingBox())?.height, 'the same fixed height as every other card').toBe(
            (await parakeet.boundingBox())?.height,
          );
          expect(await card.locator('.fy-engine-name').innerText()).toBe('Google live words');
          expect(await card.locator('.fy-engine-chip').allInnerTexts()).toEqual(['Live words', 'On device']);
          // Speed and Size are measured; Accuracy was not run on the 33 key terms, so it is not drawn.
          const bars = await card.locator('.fy-engine-bars').innerText();
          expect(bars).toContain('Speed');
          expect(bars).toContain('Size');
          expect(bars).not.toContain('Accuracy');
          expect(bars).toContain('637 MB');
          const install = card.getByRole('button', { name: /Install/u });
          expect(await install.innerText()).toContain('637 MB');
          expect((await install.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
          if (shotsDir !== '')
            await card.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-google-card.png`) });
          await card.getByRole('button', { name: 'About Google live words' }).click();
          const details = await card.locator('.fy-engine-details').innerText();
          expect(details).toContain('CC-BY-4.0');
          expect(details).toContain('Google AudioTranscriber (NVIDIA Parakeet) · CC-BY-4.0 · 25 languages');
          expect(details).toContain('637 MB to download once');
          expect(details).toContain('Measured (Chrome with the whole browser held to a quarter of one core');
          expect(details).toContain('the 33 key terms were not run');
          if (shotsDir !== '')
            await card.screenshot({ path: join(shotsDir, `${viewport.name}-${scheme}-google-card-about.png`) });
          expect(await overflowing(page)).toEqual([]);
          expect(problems).toEqual([]);
        } finally {
          await close();
        }
      });
});
