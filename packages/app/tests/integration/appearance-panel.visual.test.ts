/**
 * THE LOOK GROUP inside the REAL Settings shell (`fixtures/settings-shell-scene.tsx`: the real App, its default
 * drawer and its Settings list), measured against the PANEL the shell leaves the page and not against the document (which stays
 * 0 wide when a panel clips). A 768px window with the drawer and the list open leaves the panel 212px, which the standalone
 * scene (`appearance.visual.test.ts`) never reproduces. At 768, 1280 and 390, light and dark: every text and control box is
 * inside the panel, nothing overlaps, and the specimen's input and its focus ring are not cut.
 *
 * It also holds the keyboard promise: End on a Style card or a Palette chip moves the choice AND brings the new card or chip into
 * the window (the radios are `sr-only`, so focusing one alone leaves the visible card below the fold).
 *
 * Set `FY_APPEARANCE_PANEL_SHOTS_DIR` to keep `<viewport>-<mode>.png` (the whole Look group inside the real shell).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_APPEARANCE_PANEL_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-appearance-panel-'));
  // The entry is generated: the register module puts the real Look group on the scene's body registry, THEN imports the shell scene.
  const entry = join(directory, 'entry.tsx');
  await Bun.write(
    entry,
    `import { registerAppearanceBody } from ${JSON.stringify(resolve(packageRoot, 'fixtures/appearance-panel-register.tsx'))};\nregisterAppearanceBody();\nawait import(${JSON.stringify(resolve(packageRoot, 'fixtures/settings-shell-scene.tsx'))});\n`,
  );
  const child = Bun.spawn([process.execPath, sceneBuilder, '--out', directory, '--entry', entry], {
    cwd: packageRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
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
  { name: '768-light', width: 768, height: 844, phone: false, scheme: 'light' },
  { name: '768-dark', width: 768, height: 844, phone: false, scheme: 'dark' },
  { name: '1280-light', width: 1_280, height: 844, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 844, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;
interface Variant {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
  readonly scheme: 'light' | 'dark';
}

/** Runs in the page: every way the settings panel clips, wraps badly or overlaps, as short sentences. */
const panelProblems = (): string[] => {
  const panel = document.querySelector<HTMLElement>('.fy-settings-page');
  if (panel === null) return ['the real Settings panel (.fy-settings-page) is not on the page'];
  const bounds = panel.getBoundingClientRect();
  const problems: string[] = [];
  const name = (el: Element): string => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
  if (panel.scrollWidth - panel.clientWidth > 0)
    problems.push(`the panel scrolls sideways by ${String(panel.scrollWidth - panel.clientWidth)}px`);
  const shown = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && getComputedStyle(el).visibility !== 'hidden';
  };
  const leaves = [...panel.querySelectorAll('*')].filter(
    el =>
      shown(el) &&
      el.closest('.sr-only') === null &&
      (['BUTTON', 'INPUT', 'SELECT'].includes(el.tagName) ||
        (el.children.length === 0 && (el.textContent ?? '').trim() !== '' && el.tagName !== 'svg')),
  );
  for (const el of leaves) {
    const rect = el.getBoundingClientRect();
    if (rect.right > bounds.right + 1 || rect.left < bounds.left - 1)
      problems.push(
        `"${name(el)}" is ${String(Math.round(Math.max(rect.right - bounds.right, bounds.left - rect.left)))}px outside the panel`,
      );
    const style = getComputedStyle(el);
    if (
      el.scrollWidth > el.clientWidth + 1 &&
      el.clientWidth > 0 &&
      (style.overflowX === 'hidden' || style.overflowX === 'clip') &&
      style.textOverflow !== 'ellipsis'
    )
      problems.push(`"${name(el)}" is clipped inside its own box`);
  }
  // The specimen's focus ring (outline + shadow) must be inside the panel too, not just the input's border box.
  const input = panel.querySelector<HTMLElement>('.fy-spec__input');
  if (input !== null) {
    const rect = input.getBoundingClientRect();
    const css = getComputedStyle(input);
    const reach = parseFloat(css.outlineWidth) + Math.max(0, parseFloat(css.outlineOffset));
    if (rect.left - reach < bounds.left - 1 || rect.right + reach > bounds.right + 1)
      problems.push('the specimen input focus ring is cut by the panel');
  }
  // Nothing in the specimen or a row overlaps its neighbour (line boxes, not bounding boxes).
  for (const row of panel.querySelectorAll('li, .fy-spec__section, .fy-spec__row')) {
    const inRow = leaves.filter(el => row.contains(el) && el.closest('li, .fy-spec__section, .fy-spec__row') === row);
    for (const [i, a] of inRow.entries())
      for (const b of inRow.slice(i + 1)) {
        const touching = [...a.getClientRects()].some(x =>
          [...b.getClientRects()].some(
            y =>
              Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 &&
              Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1,
          ),
        );
        if (touching) problems.push(`"${name(a)}" overlaps "${name(b)}"`);
      }
  }
  return problems;
};

const open = async (variant: Variant) => {
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
  tab.setDefaultTimeout(12_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/d/ws/settings/usage/budgets?theme=studio-${variant.scheme}`);
  await tab.waitForSelector('[data-specimen]');
  return { tab, problems, close: async () => await context.close() };
};

describe('Settings › This device › Look, inside the real shell', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: every text and control is inside the panel and nothing overlaps`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        if (variant.width === 768) {
          // The case this test exists for: the drawer and the Settings list are both open, so the panel is narrow.
          const width = await tab.locator('.fy-settings-page').evaluate(node => node.getBoundingClientRect().width);
          expect(width, 'the panel is the narrow one a 768 window leaves').toBeLessThan(300);
        }
        await tab.waitForTimeout(400);
        if (shotsDir !== '') {
          await tab.setViewportSize({ width: variant.width, height: 5_200 });
          await tab.waitForTimeout(300);
          await tab.locator('[data-setting-group="Look"]').screenshot({ path: join(shotsDir, `${variant.name}.png`) });
          await tab.setViewportSize({ width: variant.width, height: variant.height });
        }
        expect(await tab.evaluate(panelProblems)).toEqual([]);
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});

/** Is the VISIBLE label of this radio inside the window (and clear of the phone's bottom bar)? */
const labelInWindow = async (tab: Page, selector: string): Promise<{ top: number; bottom: number; height: number }> =>
  await tab.evaluate(sel => {
    const rect = document.querySelector(sel)?.closest('label')?.getBoundingClientRect();
    return { top: rect?.top ?? -1, bottom: rect?.bottom ?? -1, height: window.innerHeight };
  }, selector);

describe('Settings › This device › Look: a keyboard move shows the card it lands on', () => {
  for (const [width, name, phone] of [
    [390, '390', true],
    [768, '768', false],
  ] as const) {
    it(`${name}: End on the selected Style card checks the last style AND brings its card into the window`, async () => {
      const { tab, close } = await open({ name, width, height: 700, phone, scheme: 'light' });
      try {
        await tab.locator('[data-choice] input:checked').focus();
        await tab.keyboard.press('End');
        const last = await tab.locator('[data-choice]').last().getAttribute('data-choice');
        expect(await tab.locator(`[data-choice="${last}"] input`).isChecked()).toBe(true);
        expect(await tab.evaluate(() => document.activeElement?.getAttribute('value'))).toBe(last);
        await tab.waitForTimeout(800); // a smooth scroll settles
        const box = await labelInWindow(tab, `[data-choice="${last}"] input`);
        expect(box.top, 'the last card starts inside the window').toBeGreaterThanOrEqual(-4);
        // 4px of slack: the card was scaled 0.98 by its select pulse when it was scrolled to.
        expect(box.bottom, 'the last card ends inside the window').toBeLessThanOrEqual(box.height + 4);
      } finally {
        await close();
      }
    });
  }

  it('390: End on the selected Palette chip checks the last palette AND brings its chip into the window', async () => {
    const { tab, close } = await open({ name: '390', width: 390, height: 700, phone: true, scheme: 'light' });
    try {
      await tab.locator('[data-palette-chip] input:checked').focus();
      await tab.keyboard.press('End');
      const last = await tab.locator('[data-palette-chip]').last().getAttribute('data-palette-chip');
      expect(await tab.locator(`[data-palette-chip="${last}"] input`).isChecked()).toBe(true);
      const box = await labelInWindow(tab, `[data-palette-chip="${last}"] input`);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(box.height + 4);
    } finally {
      await close();
    }
  });
});
