/**
 * THE SETTINGS SHELL in a real browser over fake data (`fixtures/settings-shell-scene.tsx`): the real shell over one fake
 * machine whose tabs are the real declarations of every shipped plugin; no daemon.
 *
 *  - SETTINGS lists its tabs under titled groups (v4 parity), and reaches This device from the page itself;
 *  - THIS DEVICE links back to the daemon's Settings;
 *
 * Set `FY_SETTINGS_SHELL_SHOTS_DIR` to keep `<viewport>-<case>.png` (desktop 1280 and phone 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SETTINGS_SHELL_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-settings-shell-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/settings-shell-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the settings shell scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;

type Variant = { name: string; width: number; height: number; phone: boolean; scheme: 'light' | 'dark' };

const open = async (variant: Variant, path: string, ready: string) => {
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
  const theme = `studio-${variant.scheme}`;
  await tab.goto(`${origin}${path}${path.includes('?') ? '&' : '?'}theme=${theme}`);
  try {
    await tab.waitForSelector(ready, { timeout: 8_000 });
  } catch (error) {
    const seen = (
      await tab
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 600);
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}\nON SCREEN: ${seen}`);
  }
  return { tab, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

/** The page scrolls inside the app shell, so a "full page" shot of a phone is a tall window. */
const tall = async (tab: Page, variant: Variant, height: number): Promise<void> => {
  if (variant.phone) await tab.setViewportSize({ width: variant.width, height });
};

describe('Settings shell', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: Settings lists its tabs under titled groups, with This device one click away`, async () => {
      const { tab, close } = await open(variant, '/d/ws/settings', 'nav[aria-label="Plugin settings"] .fy-tab-group');
      try {
        // The list has two blocks: the device block first, then the machine's. The machine block keeps the group order;
        // Agenda (this browser's notification filter) sits in the device block, so it is asserted there on its own.
        const machineHeadings = await tab
          .locator('nav[aria-label="Plugin settings"] section[aria-labelledby="fy-settings-block-machine"] summary')
          .allInnerTexts();
        expect(machineHeadings.slice(0, 3)).toEqual(['Behaviour', 'Agents and logins', 'Supervision']);
        expect(machineHeadings).toContain('Devices & access');
        expect(machineHeadings).not.toContain('More');
        const deviceBlock = tab.locator(
          'nav[aria-label="Plugin settings"] section[aria-labelledby="fy-settings-block-device"]',
        );
        expect(await deviceBlock.locator('a', { hasText: /^Agenda$/ }).count(), 'Agenda is a device-block tab').toBe(1);
        expect(
          await tab.locator('section[aria-labelledby="fy-settings-block-machine"] a', { hasText: /^Agenda$/ }).count(),
          'and not in the machine block',
        ).toBe(0);
        expect(await tab.getByRole('link', { name: 'This device', exact: true }).getAttribute('href')).toBe(
          '/settings',
        );
        await tall(tab, variant, 2_300);
        await shotOf(tab, variant, 'settings-groups');
      } finally {
        await close();
      }
    });

    it(`${variant.name}: This device links back to the daemon's Settings`, async () => {
      const { tab, close } = await open(variant, '/settings', '[aria-label="Daemon settings"]');
      try {
        expect(await tab.locator('[aria-label="Daemon settings"] a').getAttribute('href')).toBe('/d/ws/settings');
        await tall(tab, variant, 2_300);
        await shotOf(tab, variant, 'this-device');
      } finally {
        await close();
      }
    });
  }
});

/**
 * PICKING A SETTINGS TAB SHOWS IT. The list of titled groups sits BESIDE the page on a wide window and is a page of its own on
 * a phone (a tab opens full-screen, with a way back); only the group holding the current tab is open. Either way the picked
 * page starts at the top of the screen and takes focus.
 */
const PICKED: readonly Variant[] = [
  { name: '390x844', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '1280x713', width: 1_280, height: 713, phone: false, scheme: 'light' },
  { name: '1920x1080', width: 1_920, height: 1_080, phone: false, scheme: 'light' },
];

/** Open a tab from the list: its group first when it is shut, and the way back first when a phone shows a page. */
const pick = async (tab: Page, label: string): Promise<void> => {
  const back = tab.locator('.fy-settings-back');
  if (await back.isVisible()) await back.click();
  const link = tab.getByRole('link', { name: label, exact: true });
  if (!(await link.isVisible())) await tab.locator(`details.fy-tab-group:has(a:text-is("${label}")) > summary`).click();
  await link.click();
};

describe('Settings shell: a picked tab is on screen', () => {
  for (const variant of PICKED) {
    it(`${variant.name}: clicking Budgets scrolls its page into sight and focuses it; reading it is not blocked`, async () => {
      const { tab, close } = await open(variant, '/d/ws/settings', 'nav[aria-label="Plugin settings"] .fy-tab-group');
      try {
        const page = tab.locator('.fy-settings-page');
        await shotOf(tab, variant, 'picked-0-before');
        await pick(tab, 'Budgets');
        await tab.waitForSelector('text=Budgets settings (fake data)');
        await tab.waitForFunction(() => document.activeElement?.classList.contains('fy-settings-page') === true);
        expect(await page.getAttribute('aria-label')).toBe('Budgets');
        const box = await page.boundingBox();
        expect(box).not.toBeNull();
        // The page starts at the top of the screen (beside the list, or full-screen on a phone).
        expect(box?.y ?? 9_999).toBeLessThan(400);
        expect(await tab.getByText('Budgets settings (fake data)').isVisible()).toBe(true);
        const sideways = await tab.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(sideways).toBeLessThanOrEqual(0);
        await shotOf(tab, variant, 'picked-1-budgets');
        // And another tab can be picked from the list (a phone goes back to it first).
        await pick(tab, 'Logins');
        await tab.waitForSelector('text=Logins settings (fake data)');
        expect(await page.getAttribute('aria-label')).toBe('Logins');
        expect((await page.boundingBox())?.y ?? 9_999).toBeLessThan(400);
        await shotOf(tab, variant, 'picked-2-logins');
      } finally {
        await close();
      }
    });
  }

  it('390x844: a deep link to a tab opens with the page in sight', async () => {
    const variant = PICKED[0] as Variant;
    const { tab, close } = await open(variant, '/d/ws/settings/logins', '.fy-settings-page');
    try {
      await tab.waitForSelector('text=Logins settings (fake data)');
      expect((await tab.locator('.fy-settings-page').boundingBox())?.y ?? 9_999).toBeLessThan(variant.height / 2);
      await shotOf(tab, variant, 'picked-deep-link');
    } finally {
      await close();
    }
  });
});

/**
 * R10 S1: THE FRAME'S OWN RULES, as the browser computes them. A flex label inside a page stays flex (the page's old
 * `label {display:block}` beat Tailwind's `.flex`); a form's bare label is still a block; the nav's links read in the body
 * colour and only the current item carries the accent bar; the content is at most 1,100px wide; the list has its two blocks.
 */
describe('Settings shell: the frame rules (S1)', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: labels, nav colour, content width and the two list blocks`, async () => {
      const { tab, close } = await open(variant, '/d/ws/settings', 'nav[aria-label="Plugin settings"] .fy-tab-group');
      try {
        const facts = await tab.evaluate(() => {
          const page = document.querySelector('.fy-page') as HTMLElement;
          const probe = document.createElement('div');
          probe.innerHTML =
            '<label class="flex" id="s1-flex"><input type="radio"> flex</label><form><label id="s1-form"><input type="text"></label></form>';
          page.append(probe);
          const display = (id: string) => getComputedStyle(document.getElementById(id) as HTMLElement).display;
          const colour = (el: Element) => getComputedStyle(el).color;
          const links = [...document.querySelectorAll('.fy-settings-nav .fy-tab:not(.fy-tab--active)')];
          const active = document.querySelector('.fy-settings-nav .fy-tab--active') as HTMLElement | null;
          const body = getComputedStyle(document.body).color;
          const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
          const out = {
            flex: display('s1-flex'),
            form: display('s1-form'),
            linkColours: [...new Set(links.map(colour))],
            fgProbe: (() => {
              const p = document.createElement('i');
              p.style.color = 'var(--fg)';
              document.body.append(p);
              const c = getComputedStyle(p).color;
              p.remove();
              return c;
            })(),
            bodyColour: body,
            fg,
            activeShadow: active === null ? '' : getComputedStyle(active).boxShadow,
            activeFill: active === null ? '' : getComputedStyle(active).backgroundColor,
            activeWeight: active === null ? '' : getComputedStyle(active).fontWeight,
            restFill: links[0] === undefined ? '' : getComputedStyle(links[0]).backgroundColor,
            blocks: [...document.querySelectorAll('.fy-settings-block__title')].map(el => el.textContent),
            pageMax: ((el: Element | null) => (el === null ? '' : getComputedStyle(el).maxWidth))(
              document.querySelector('.fy-settings-page'),
            ),
          };
          probe.remove();
          return out;
        });
        expect(facts.flex).toBe('flex');
        expect(facts.form).toBe('block');
        expect(facts.linkColours).toEqual([facts.fgProbe]);
        // A phone's bare Settings is the list alone: no item is current and no page is mounted.
        // The current item reads by a soft fill and a 600 weight, and draws NO accent side bar (r11 S2, a1ced4a412: the
        // old inset box-shadow bar is gone app-wide, which is what this line used to assert).
        if (!variant.phone) {
          expect(facts.activeShadow, 'no side bar on the current item').toBe('none');
          expect(facts.activeFill, 'a fill marks the current item').not.toBe('rgba(0, 0, 0, 0)');
          expect(facts.activeFill).not.toBe(facts.restFill);
          expect(facts.activeWeight).toBe('600');
        }
        expect(facts.blocks[0]).toBe('Just this device');
        expect(facts.blocks[1]).toMatch(/ · every device$/);
        if (!variant.phone) expect(facts.pageMax).toBe('1100px');
        await tall(tab, variant, 2_300);
        await shotOf(tab, variant, 'frame-s1');
      } finally {
        await close();
      }
    });
  }
});

/**
 * R10 S8: THE AGENDA TAB INSIDE THE REAL SHELL (`?real=agenda`: the real notification settings over local state). The
 * Settings panel is much narrower than the window (212px wide at 768, 264 at 820, 724 at 1280), so the five tiles pick
 * their columns from the PANEL; every name and hint wraps inside its tile, none is clipped, and nothing scrolls sideways.
 */
const AGENDA_VARIANTS: readonly Variant[] = [
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
  { name: '768-light', width: 768, height: 900, phone: false, scheme: 'light' },
  { name: '768-dark', width: 768, height: 900, phone: false, scheme: 'dark' },
  { name: '820-light', width: 820, height: 900, phone: false, scheme: 'light' },
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
];

describe('Settings shell: the Agenda tab (S8)', () => {
  for (const variant of AGENDA_VARIANTS) {
    it(`${variant.name}: the tiles follow the panel's width and no label or hint is clipped`, async () => {
      const { tab, close } = await open(variant, '/d/ws/settings/agenda?real=agenda', '.fy-notify-grid');
      try {
        await tab.waitForSelector('.fy-notify-grid [role="switch"]');
        const facts = await tab.evaluate(() => {
          const grid = document.querySelector('.fy-notify-grid') as HTMLElement;
          const panel = (document.querySelector('.fy-notify-tiles') as HTMLElement).getBoundingClientRect().width;
          const tiles = [...grid.querySelectorAll('[role="switch"]')].map(tile => {
            const box = tile.getBoundingClientRect();
            const texts = [...tile.querySelectorAll('span.block')].map(span => {
              const range = document.createRange();
              range.selectNodeContents(span);
              const text = range.getBoundingClientRect();
              const own = span.getBoundingClientRect();
              return {
                words: span.textContent ?? '',
                clippedX: span.scrollWidth > span.clientWidth + 1,
                clippedY: span.scrollHeight > span.clientHeight + 1,
                outside: text.right > box.right + 0.5 || text.left < box.left - 0.5 || text.right > own.right + 0.5,
                overflow: getComputedStyle(span).overflow,
              };
            });
            const glyph = tile.lastElementChild?.getBoundingClientRect();
            return {
              top: Math.round(box.top),
              left: Math.round(box.left),
              width: box.width,
              glyphInside: glyph !== undefined && glyph.right <= box.right + 0.5 && glyph.left >= box.left,
              texts,
            };
          });
          return {
            panel,
            tiles,
            columns: new Set(tiles.map(tile => tile.left)).size,
            sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        expect(facts.tiles).toHaveLength(5);
        const wanted = facts.panel >= 780 ? 3 : facts.panel >= 520 ? 2 : 1;
        expect(facts.columns, `panel ${facts.panel}px`).toBe(wanted);
        for (const tile of facts.tiles) {
          expect(tile.glyphInside, 'the switch stays inside its tile').toBe(true);
          expect(tile.texts).toHaveLength(2);
          for (const text of tile.texts) {
            expect(text.clippedX, `${text.words} is not clipped sideways`).toBe(false);
            expect(text.clippedY, `${text.words} is not clipped vertically`).toBe(false);
            expect(text.outside, `${text.words} stays inside its tile`).toBe(false);
            expect(text.overflow, `${text.words} does not hide overflow`).toBe('visible');
          }
        }
        expect(facts.sideways).toBeLessThanOrEqual(0);
        await tall(tab, variant, 1_400);
        await shotOf(tab, variant, 'agenda-tiles');
        // Quiet hours: switch it on, then shoot once the switch has finished moving.
        await tab.click('[data-quiet-hours-row] [role="switch"]');
        await tab.waitForSelector('[data-quiet-hours-row] input[type="time"]');
        await tab.evaluate(async () => {
          await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)));
        });
        const after = await tab.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(after).toBeLessThanOrEqual(0);
        await shotOf(tab, variant, 'agenda-quiet-hours');
      } finally {
        await close();
      }
    });
  }
});
