/**
 * THE BADGE ROW and the LOOK PICKER in a real browser over fake data (`fixtures/badge-picker-scene.tsx`):
 *   - a very long badge label stays inside its container at 390 in EVERY style, ends in an ellipsis, and the full text is
 *     still its title;
 *   - the Gen Z sticker tilt stays inside its own line box (it never overdraws the line above or below);
 *   - every style's picker mini draws a signature of its own (type, weight, label case, button and card chrome, blur), so
 *     no two styles look alike.
 *
 * Set `FY_BADGE_PICKER_SHOTS_DIR` to keep `<viewport>-<mode>-<case>.png` (1280 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { STYLES } from '../../src/theme/catalog.ts';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(120_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_BADGE_PICKER_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-badge-picker-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/badge-picker-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the badge picker scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
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
  { name: '1280-light', width: 1_280, height: 1_300, phone: false, mode: 'light' },
  { name: '1280-dark', width: 1_280, height: 1_300, phone: false, mode: 'dark' },
  { name: '390-light', width: 390, height: 900, phone: true, mode: 'light' },
  { name: '390-dark', width: 390, height: 900, phone: true, mode: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant, style: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.mode,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?style=${style}&palette=studio&mode=${variant.mode}`);
  await tab.waitForSelector('[data-badge-row] .kt-badge');
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, problems, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`), fullPage: true });
};

describe('a long badge label', () => {
  for (const style of STYLES) {
    it(`should stay inside its container at 390 in ${style.id}, ellipsised or wrapped, the full text in the title`, async () => {
      const { tab, problems, close } = await open(VARIANTS[2], style.id);
      try {
        const m = await tab.evaluate(() => {
          const badge = document.querySelector('[data-badge-row] [data-badge-host] .kt-badge') as HTMLElement;
          const host = document.querySelector('[data-badge-host]') as HTMLElement;
          const text = badge.querySelector('.kt-badge__text') as HTMLElement;
          const b = badge.getBoundingClientRect();
          const h = host.getBoundingClientRect();
          return {
            inside: b.left >= h.left - 0.5 && b.right <= h.right + 0.5,
            pageWide: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            clipped: text.scrollWidth > text.clientWidth,
            overflow: getComputedStyle(text).textOverflow,
            wraps: getComputedStyle(text).whiteSpace === 'normal',
            title: badge.getAttribute('title') ?? '',
            full: text.textContent ?? '',
          };
        });
        expect(m.inside).toBe(true);
        expect(m.pageWide).toBeLessThanOrEqual(m.innerWidth);
        // A style that WRAPS a badge on purpose (pixel) keeps every letter on screen; every other one ellipsises.
        if (!m.wraps) {
          expect(m.clipped).toBe(true);
          expect(m.overflow).toBe('ellipsis');
        }
        expect(m.title).toBe(m.full);
        expect(problems).toEqual([]);
        if (style.id === 'studio' || style.id === 'genz') await shotOf(tab, VARIANTS[2], `badge-${style.id}`);
      } finally {
        await close();
      }
    });
  }

  it('should keep a short badge at its natural width, un-ellipsised', async () => {
    const { tab, close } = await open(VARIANTS[0], 'studio');
    try {
      const clipped = await tab.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-short] .kt-badge__text')].map(
          text => text.scrollWidth > text.clientWidth,
        ),
      );
      expect(clipped).toEqual([false, false]);
    } finally {
      await close();
    }
  });
});

describe('the Gen Z sticker', () => {
  for (const variant of VARIANTS) {
    it(`should tilt inside its own line box without overdrawing the next line (${variant.name})`, async () => {
      const { tab, close } = await open(variant, 'genz');
      try {
        const m = await tab.evaluate(() => {
          const rect = (selector: string) => (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
          return {
            badge: rect('[data-badge-host] .kt-badge'),
            before: rect('[data-line="before"]'),
            after: rect('[data-line="after"]'),
          };
        });
        // getBoundingClientRect is the TILTED box: it must sit between the two lines, touching neither.
        expect(m.badge.top).toBeGreaterThanOrEqual(m.before.bottom);
        expect(m.badge.bottom).toBeLessThanOrEqual(m.after.top);
        await shotOf(tab, variant, 'genz-badge');
      } finally {
        await close();
      }
    });
  }
});

describe('the Look picker minis', () => {
  for (const variant of VARIANTS) {
    it(`should draw a signature of its own in every style (${variant.name})`, async () => {
      const { tab, problems, close } = await open(variant, 'studio');
      try {
        const signatures = await tab.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.fy-cc__card')].map(card => {
            const get = (selector: string, props: readonly string[]) => {
              const style = getComputedStyle(card.querySelector(selector) as HTMLElement);
              return props.map(prop => style.getPropertyValue(prop)).join('|');
            };
            return {
              id: card.getAttribute('data-choice') ?? '',
              signature: [
                get('.fy-ap-mini__type', ['font-family', 'font-weight', 'letter-spacing']),
                get('.fy-ap-mini__body', ['font-family', 'font-weight']),
                get('.fy-ap-mini__label', ['font-family', 'text-transform', 'letter-spacing']),
                get('.fy-ap-mini__button', ['border-radius', 'border-top-width', 'box-shadow']),
                get('.fy-ap-mini__card', ['border-radius', 'border-top-width', 'box-shadow', 'backdrop-filter']),
                get('.fy-ap-mini', ['border-radius', 'background-image']),
              ].join('||'),
            };
          }),
        );
        expect(signatures.map(entry => entry.id)).toEqual(STYLES.map(style => style.id));
        const seen = new Map<string, string>();
        for (const { id, signature } of signatures) {
          expect([id, seen.get(signature)]).toEqual([id, undefined]);
          seen.set(signature, id);
        }
        const glass = signatures.find(entry => entry.id === 'glass')?.signature ?? '';
        expect(glass).toContain('blur(');
        expect(problems).toEqual([]);
        await shotOf(tab, variant, 'picker');
      } finally {
        await close();
      }
    });
  }
});
