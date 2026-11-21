/**
 * THE SHELLS ONBOARDING STEP in a real browser over fake data (r10 O13): the real step body inside the shell's frame (the
 * frame is wrapped in the fixture only), at 1280 and 390 wide, light and dark, for the two things it can say: nix is
 * missing (what ferrets use instead), and the check failed ("Couldn't check", with a retry).
 *
 * Set `FY_SHELLS_STEP_SHOTS_DIR` to keep `<viewport>-<scheme>-<missing|unreadable>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm as removeTree } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_SHELLS_STEP_SHOTS_DIR ?? '';

let browser: Browser;
let built = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  built = await mkdtemp(join(tmpdir(), 'ferretry-shells-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', built, '--entry', 'fixtures/shells-step-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the shells step scene did not build (${code}):\n${stderr}\n${stdout}`);
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
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (built !== '') await removeTree(built, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280', width: 1_280, height: 720, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

describe('The Shells onboarding step', () => {
  for (const variant of VARIANTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const outcome of ['missing', 'unreadable'] as const)
        it(`reads clearly inside the shell's frame (${variant.name}, ${scheme}, ${outcome})`, async () => {
          const context = await browser.newContext({
            viewport: { width: variant.width, height: variant.height },
            colorScheme: scheme,
            deviceScaleFactor: variant.phone ? 2 : 1,
            hasTouch: variant.phone,
            isMobile: variant.phone,
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const page = await context.newPage();
          try {
            await page.goto(`${origin}/?theme=studio-${scheme}&case=${outcome}`);
            await page.waitForSelector(`[data-testid="shells-step"][data-outcome="${outcome}"]`);
            const text = (await page.textContent('[data-testid="shells-step"]')) ?? '';
            if (outcome === 'unreadable') {
              expect(text).toContain('Couldn’t check');
              expect(await page.$$('[data-shells-step-retry]')).toHaveLength(1);
            } else {
              expect(text).toContain('Nix is missing');
              expect(await page.$$('[data-shells-step-retry]')).toHaveLength(0);
            }
            expect(await page.$$('[data-step-later]'), 'the body draws no Later of its own').toHaveLength(0);
            expect(await page.$$('h1'), 'one title: the frame’s').toHaveLength(1);
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await page.screenshot({ path: join(shotsDir, `${variant.name}-${scheme}-${outcome}.png`) });
          } finally {
            await context.close();
          }
        }, 60_000);
});

/**
 * r11 O13: THE SHELLS PAGE, laid out as the owner asked (items 3 and 5): the picture on the right, the words cut. Real
 * Chromium over fake data inside the real step frame. At 1280 the demo (`[data-step-demo]`) is right of the words (gap
 * > 32px) and top-aligned with them (within 8px); at 390 it is above them and at most 140px tall, with nothing
 * scrolling sideways. The page text is at most 160 characters, it has no button of its own when nix is missing (the one
 * retry button of the failed check is the only exception), and Next saves nothing: the page registers no commit.
 */
describe('r11 O13: the Shells page layout', () => {
  for (const variant of VARIANTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const outcome of ['missing', 'unreadable'] as const)
        it(`puts the demo beside the words and keeps them short (${variant.name}, ${scheme}, ${outcome})`, async () => {
          const context = await browser.newContext({
            viewport: { width: variant.width, height: variant.height },
            colorScheme: scheme,
            deviceScaleFactor: variant.phone ? 2 : 1,
            hasTouch: variant.phone,
            isMobile: variant.phone,
          });
          const origin = server?.url.origin ?? '';
          await context.route('**/*', async route =>
            new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
          );
          const page = await context.newPage();
          try {
            await page.goto(`${origin}/?theme=studio-${scheme}&case=${outcome}`);
            await page.waitForSelector(`[data-testid="shells-step"][data-outcome="${outcome}"]`);
            await page.waitForTimeout(1_300);
            const look = await page.evaluate(() => {
              const luminance = (css: string): number => {
                const [r = 0, g = 0, b = 0] = (css.match(/[\d.]+/g) ?? []).map(Number);
                return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
              };
              const root = document.documentElement;
              const copy = document.querySelector('.fy-shells-step p') as HTMLElement;
              return {
                palette: root.dataset.palette,
                mode: root.dataset.mode,
                bg: luminance(getComputedStyle(document.body).backgroundColor),
                fg: luminance(getComputedStyle(copy).color),
              };
            });
            expect(look.palette).toBe('studio');
            expect(look.mode).toBe(scheme);
            // The mode colours are computed from the palette selectors, not just attributes: dark is dark ink-on-night.
            if (scheme === 'dark') {
              expect(look.bg, 'dark: the page background is dark').toBeLessThan(0.25);
              expect(look.fg, 'dark: the words are light').toBeGreaterThan(0.6);
            } else {
              expect(look.bg, 'light: the page background is light').toBeGreaterThan(0.75);
              expect(look.fg, 'light: the words are dark').toBeLessThan(0.4);
            }
            const m = await page.evaluate(() => {
              const box = (node: Element | null) => {
                const r = node?.getBoundingClientRect() ?? new DOMRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
              };
              const step = document.querySelector('[data-testid="shells-step"]');
              const body = document.querySelector('.fy-spf__body') as HTMLElement;
              const words = [...(step?.children ?? [])].filter(node => !node.hasAttribute('data-step-demo'));
              const demo = document.querySelector('[data-step-demo]') as HTMLElement | null;
              const footer = ['[data-step-back]', '[data-step-later]', '[data-step-next]'].map(s =>
                box(document.querySelector(s)),
              );
              return {
                demo: box(demo),
                hasDemo: demo !== null && demo.textContent !== '',
                words: words.map(box),
                // The whole main area: the copy column AND the demo column the portal draws beside it.
                text: (document.querySelector('.fy-spf__main') as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
                buttons: body.querySelectorAll('button').length,
                writes: window.__writes,
                overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                viewport: window.innerWidth,
                footer,
                clipped: [...body.querySelectorAll('p')].filter(p => p.scrollWidth > p.clientWidth + 1).length,
              };
            });
            expect(m.hasDemo, 'the picture is drawn into the frame’s demo column, and only for a real answer').toBe(
              outcome === 'missing',
            );
            expect(m.words.length).toBeGreaterThan(0);
            if (outcome === 'unreadable') {
              // No picture claims what ferrets use when the check failed: nothing to place beside the words.
            } else if (variant.phone) {
              expect(m.demo.bottom).toBeLessThanOrEqual((m.words[0]?.y ?? 0) + 1);
              expect(m.demo.h).toBeLessThanOrEqual(140);
              for (const button of m.footer) {
                expect(button.x).toBeGreaterThanOrEqual(0);
                expect(button.right).toBeLessThanOrEqual(m.viewport);
              }
            } else {
              const wordsRight = Math.max(...m.words.map(word => word.right));
              expect(m.demo.x).toBeGreaterThan(wordsRight + 32);
              expect(Math.abs(m.demo.y - (m.words[0]?.y ?? 0))).toBeLessThanOrEqual(8);
            }
            expect(m.overflowX).toBe(false);
            expect(m.text.length, `main area text (${m.text.length}): ${m.text}`).toBeLessThanOrEqual(160);
            expect(m.buttons).toBe(outcome === 'unreadable' ? 1 : 0);
            expect(m.writes, 'nothing here is a pick, so nothing is registered to save').toEqual([]);
            expect(m.clipped).toBe(0);
            if (shotsDir !== '')
              await page.screenshot({ path: join(shotsDir, `after-${variant.name}-${scheme}-${outcome}.png`) });
          } finally {
            await context.close();
          }
        }, 60_000);
});

/**
 * r11 O13 (review item 2): the demo's motion is REAL. By the time the page is measured the 560 ms animation is over, so
 * presence at 1300 ms would pass with the animation deleted. Here a fresh copy of each demo row is inserted (the same
 * stylesheet rule matches it, and CSS starts its animation at once), paused, and read at its start and its end: the start
 * is invisible and lifted, the end is at rest. With motion reduced there is no animation and the rows are at rest.
 */
describe('r11 O13: the Shells demo animates', () => {
  async function open(reduced: boolean) {
    const context = await browser.newContext({
      viewport: { width: 1_280, height: 720 },
      reducedMotion: reduced ? 'reduce' : 'no-preference',
    });
    const origin = server?.url.origin ?? '';
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
    );
    const page = await context.newPage();
    await page.goto(`${origin}/?theme=studio-light&case=missing`);
    await page.waitForSelector('[data-shells-demo]');
    return { context, page };
  }
  const probe = () => {
    const demo = document.querySelector('[data-shells-demo]') as HTMLElement;
    return ['.fy-shd__row[data-without]', '.fy-shd__row--with'].map(selector => {
      const row = (demo.querySelector(selector) as HTMLElement).cloneNode(true) as HTMLElement;
      row.dataset.probe = '';
      demo.append(row);
      const running = row.getAnimations().filter(a => (a as CSSAnimation).animationName === 'fy-shd-in');
      const read = (at: number | undefined) => {
        for (const a of running) {
          a.pause();
          if (at !== undefined) a.currentTime = at;
        }
        const style = getComputedStyle(row);
        const lift = new DOMMatrix(style.transform === 'none' ? undefined : style.transform).m42;
        return { opacity: Number(style.opacity), lift };
      };
      const start = read(0);
      const end = read(10_000);
      row.remove();
      return { animations: running.length, start, end };
    });
  };
  it('plays: each row starts invisible and lifted, and ends visible and at rest', async () => {
    const { context, page } = await open(false);
    try {
      const rows = await page.evaluate(probe);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.animations, 'a CSS animation runs on the row').toBe(1);
        expect(row.start.opacity, 'it starts invisible').toBeLessThan(0.05);
        expect(row.start.lift, 'it starts lifted').toBeLessThan(-4);
        expect(row.end.opacity, 'it ends visible').toBe(1);
        expect(row.end.lift, 'it ends at rest').toBe(0);
      }
    } finally {
      await context.close();
    }
  }, 60_000);
  it('with motion reduced nothing animates and the finished picture is already there', async () => {
    const { context, page } = await open(true);
    try {
      const rows = await page.evaluate(probe);
      for (const row of rows) {
        expect(row.animations).toBe(0);
        expect(row.start.opacity).toBe(1);
        expect(row.start.lift).toBe(0);
      }
    } finally {
      await context.close();
    }
  }, 60_000);
});
