/**
 * C59 O2: THE PAIR CONFIRM PAGE IS BALANCED. A real browser measures the computed geometry of the first onboarding
 * screen (`fixtures/pairing-scene.tsx`, fake data, a fixed fake code) on a phone (390) and a desktop (1280), light and dark:
 *
 *  1. "Rename" is a small text-size control ON the "This device will be called X" line: it is no taller than the line
 *     around it, shares its baseline row, and does not make the line taller than one text line.
 *  2. "Pair this device" and "Not now" are the same size. On a phone both span the container width, stacked; on a
 *     desktop they sit on one row across the card width with "Not now" at the left end and "Pair this device" at the right.
 *  3. The machine card hugs its content: no empty band under "Details" (more than 24px).
 *
 * C59 O3 (the Connected screen, same scene with `&offer=open`): the check is anchored on the burrow, the waving arm is drawn
 * whole (in front of the lip), the progress bar is on both pair pages, and the screen has one heading and one supporting line.
 *
 * Set `FY_PAIR_BALANCE_SHOTS_DIR` to keep `<viewport>-<scheme>-confirm.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PAIR_BALANCE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pair-balance-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/pairing-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the pairing scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body,#root{height:100%}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

const box = async (tab: Page, selector: string): Promise<Box> =>
  await tab.evaluate(sel => {
    const element = document.querySelector(sel);
    if (element === null) throw new Error(`no element for ${sel}`);
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  }, selector);

const buttonBox = async (tab: Page, name: string): Promise<Box> => {
  const handle = await tab.getByRole('button', { name, exact: true }).elementHandle();
  if (handle === null) throw new Error(`no button named ${name}`);
  return await handle.evaluate(element => {
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
};

describe('the pair confirm page is balanced (C59 O2)', () => {
  for (const variant of VARIANTS) {
    describe(`${variant.name}`, () => {
      let close = async (): Promise<void> => {};
      let tab: Page;
      beforeAll(async () => {
        const context = await browser.newContext({
          viewport: { width: variant.width, height: variant.height },
          deviceScaleFactor: variant.phone ? 2 : 1,
          hasTouch: variant.phone,
          isMobile: variant.phone,
          colorScheme: variant.scheme,
          reducedMotion: 'reduce',
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        tab = await context.newPage();
        await tab.goto(`${origin}/?theme=studio-${variant.scheme}&motion=reduced`);
        await tab.waitForSelector('[data-pair-device-rename]');
        await tab.evaluate(async () => await document.fonts.ready);
        close = async () => await context.close();
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `${variant.name}-confirm.png`), fullPage: true });
      });
      afterAll(async () => await close());

      it('Rename is a small control on the "This device will be called" line, not taller than the line', async () => {
        const line = await tab.evaluate(() => {
          const label = document.querySelector('[data-pair-device-label]') as HTMLElement;
          const rename = document.querySelector('[data-pair-device-rename]') as HTMLElement;
          const lh = Number.parseFloat(getComputedStyle(label).lineHeight);
          const withRename = label.getBoundingClientRect().height;
          const renameHeight = rename.getBoundingClientRect().height;
          const shown = rename.style.display;
          rename.style.display = 'none';
          const without = label.getBoundingClientRect().height;
          rename.style.display = shown;
          return { lineHeight: lh, withRename, without, renameHeight };
        });
        expect(line.renameHeight, 'Rename is no taller than one text line').toBeLessThanOrEqual(line.lineHeight + 1);
        expect(line.withRename, 'Rename does not change the line height').toBeLessThanOrEqual(line.without + 1);
      });

      it('Rename sits on the same line as the sentence', async () => {
        const rows = await tab.evaluate(() => {
          const label = document.querySelector('[data-pair-device-label]') as HTMLElement;
          const rename = document.querySelector('[data-pair-device-rename]') as HTMLElement;
          const range = document.createRange();
          const sentence = label.querySelector('span') as HTMLElement;
          range.selectNodeContents(sentence);
          const last = Array.from(range.getClientRects()).at(-1) as DOMRect;
          const r = rename.getBoundingClientRect();
          return { lastTop: last.top, lastBottom: last.bottom, renameTop: r.top, renameBottom: r.bottom };
        });
        const overlap = Math.min(rows.lastBottom, rows.renameBottom) - Math.max(rows.lastTop, rows.renameTop);
        expect(overlap, 'Rename shares the last text row of the sentence').toBeGreaterThan(0);
      });

      it('Pair this device and Not now are the same size', async () => {
        const pair = await buttonBox(tab, 'Pair this device');
        const later = await buttonBox(tab, 'Not now');
        expect(Math.abs(pair.width - later.width), 'same width').toBeLessThanOrEqual(1);
        expect(Math.abs(pair.height - later.height), 'same height').toBeLessThanOrEqual(1);
      });

      if (variant.phone)
        it('on a phone both answers span the container width, stacked', async () => {
          const pair = await buttonBox(tab, 'Pair this device');
          const later = await buttonBox(tab, 'Not now');
          const panel = await box(tab, '.fy-pair-scene main .kt-panel');
          expect(Math.abs(pair.width - panel.width), 'Pair spans the card width').toBeLessThanOrEqual(1);
          expect(Math.abs(later.width - panel.width), 'Not now spans the card width').toBeLessThanOrEqual(1);
          expect(Math.abs(pair.left - panel.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(later.left - panel.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(pair.top - later.top), 'stacked, not side by side').toBeGreaterThan(20);
        });
      else
        it('on a desktop Not now is at the left end and Pair this device at the right end of one row', async () => {
          const pair = await buttonBox(tab, 'Pair this device');
          const later = await buttonBox(tab, 'Not now');
          const panel = await box(tab, '.fy-pair-scene main .kt-panel');
          expect(Math.abs(pair.top - later.top), 'one row').toBeLessThanOrEqual(1);
          expect(Math.abs(later.left - panel.left), 'Not now at the left edge').toBeLessThanOrEqual(1);
          expect(Math.abs(pair.right - panel.right), 'Pair this device at the right edge').toBeLessThanOrEqual(1);
          expect(later.left).toBeLessThan(pair.left);
        });

      it('Tab reaches the two answers in the order they are drawn (top to bottom, then left to right)', async () => {
        const pair = await buttonBox(tab, 'Pair this device');
        const later = await buttonBox(tab, 'Not now');
        const drawn = [
          { name: 'Pair this device', box: pair },
          { name: 'Not now', box: later },
        ]
          .sort((a, b) => (Math.abs(a.box.top - b.box.top) > 1 ? a.box.top - b.box.top : a.box.left - b.box.left))
          .map(entry => entry.name);
        await tab.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const reached: string[] = [];
        for (let press = 0; press < 25 && reached.length < 2; press += 1) {
          await tab.keyboard.press('Tab');
          const name = await tab.evaluate(() => {
            const active = document.activeElement as HTMLElement | null;
            return active?.closest('[data-action-row]') === null || active === null
              ? ''
              : (active.textContent ?? '').trim();
          });
          if (name !== '' && !reached.includes(name)) reached.push(name);
        }
        expect(reached, `Tab order ${reached.join(' > ')} against the drawn order ${drawn.join(' > ')}`).toEqual(drawn);
      });

      it('the machine card hugs its content: no empty band under Details', async () => {
        const gap = await tab.evaluate(() => {
          const panel = document.querySelector('.fy-pair-scene main .kt-panel') as HTMLElement;
          const bottoms = Array.from(panel.querySelectorAll('*'))
            .map(element => (element as HTMLElement).getBoundingClientRect())
            .filter(r => r.height > 0 && r.width > 0)
            .map(r => r.bottom);
          const content = Math.max(...bottoms);
          const p = panel.getBoundingClientRect();
          const pad = Number.parseFloat(getComputedStyle(panel).paddingBottom);
          return { panelBottom: p.bottom, contentBottom: content, pad };
        });
        const empty = gap.panelBottom - gap.contentBottom - gap.pad;
        expect(empty, 'empty space under the last row, beyond the card padding').toBeLessThanOrEqual(24);
      });
    });
  }
});

describe('the Connected screen is balanced (C59 O3)', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: progress on both pair pages, one heading and one line, the check on the burrow, the arm whole`, async () => {
      const context = await browser.newContext({
        viewport: { width: variant.width, height: variant.height },
        deviceScaleFactor: variant.phone ? 2 : 1,
        hasTouch: variant.phone,
        isMobile: variant.phone,
        colorScheme: variant.scheme,
        reducedMotion: 'reduce',
      });
      const origin = server?.url.origin ?? '';
      await context.route('**/*', async route =>
        new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
      );
      const tab = await context.newPage();
      try {
        await tab.goto(`${origin}/?theme=studio-${variant.scheme}&motion=reduced&offer=open`);
        await tab.waitForSelector('[data-pair-device-rename]');
        // Progress is on the confirm page, in the same bar the setup pages draw.
        expect(await tab.locator('[data-step-progress]').count(), 'progress on the confirm page').toBe(1);
        expect(await tab.locator('[data-step-progress]').innerText()).toContain('Pair · 1 of 3');
        await tab.getByRole('button', { name: 'Pair this device' }).click();
        await tab.waitForSelector('[data-pairing-stage="paired"]');
        await tab.waitForSelector('[data-first-passkey-offer]');
        expect(await tab.locator('[data-step-progress]').innerText()).toContain('Connected · 2 of 3');
        // One heading, one supporting line.
        expect(await tab.locator('main h1, main h2').allInnerTexts()).toEqual(['Connected']);
        const lines = await tab.locator('[data-paired-with]').allInnerTexts();
        expect(lines).toEqual(['Paired with kirin-workstation.']);
        // The check sits inside the mascot's box (anchored to it, not floating off its corner), in the burrow's lower half.
        const geometry = await tab.evaluate(() => {
          const hero = (document.querySelector('.fy-pair-hero') as HTMLElement).getBoundingClientRect();
          const badge = (document.querySelector('.fy-pair-badge') as HTMLElement).getBoundingClientRect();
          const lip = document.querySelector('.fy-ferret-lip') as SVGElement;
          const wave = document.querySelector('[data-mascot-wave]') as SVGElement;
          return {
            hero: { l: hero.left, r: hero.right, t: hero.top, b: hero.bottom },
            badge: { l: badge.left, r: badge.right, t: badge.top, b: badge.bottom },
            armAfterLip: Boolean(lip.compareDocumentPosition(wave) & Node.DOCUMENT_POSITION_FOLLOWING),
          };
        });
        expect(geometry.badge.l, 'check inside the mascot, left').toBeGreaterThanOrEqual(geometry.hero.l);
        expect(geometry.badge.r, 'check inside the mascot, right').toBeLessThanOrEqual(geometry.hero.r);
        expect(geometry.badge.t, 'check below the mascot top').toBeGreaterThan(
          geometry.hero.t + (geometry.hero.b - geometry.hero.t) * 0.5,
        );
        expect(geometry.badge.b, 'check not below the mascot').toBeLessThanOrEqual(geometry.hero.b + 2);
        expect(
          geometry.armAfterLip,
          'the waving arm is drawn in front of the burrow lip, so the lip does not cut it',
        ).toBe(true);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `${variant.name}-connected.png`), fullPage: true });
      } finally {
        await context.close();
      }
    });
  }
});

describe('the first pairing screen draws the same progress bar (C59 O3)', () => {
  // The first screen is ONE stage with three states: paste only, paste plus a camera scan, and the /pair browse state
  // that the host gives a Back. Each must show step 1 of 3, in the bar the setup pages draw.
  const STATES = [
    { name: 'paste', query: '&arrival=cold' },
    { name: 'scan and paste', query: '&arrival=cold&scan=camera' },
    { name: '/pair browse with Back', query: '&arrival=cold&scan=camera&back=1' },
  ] as const;
  for (const variant of VARIANTS) {
    for (const state of STATES) {
      it(`${variant.name}: ${state.name} shows "Pair · 1 of 3"`, async () => {
        const context = await browser.newContext({
          viewport: { width: variant.width, height: variant.height },
          deviceScaleFactor: variant.phone ? 2 : 1,
          hasTouch: variant.phone,
          isMobile: variant.phone,
          colorScheme: variant.scheme,
          reducedMotion: 'reduce',
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        try {
          await tab.goto(`${origin}/?theme=studio-${variant.scheme}&motion=reduced${state.query}`);
          await tab.waitForSelector('[data-pairing-stage="browse"]');
          expect(await tab.locator('[data-step-progress]').count(), 'one progress bar').toBe(1);
          expect(await tab.locator('[data-step-progress]').innerText()).toContain('Pair · 1 of 3');
          const bar = await box(tab, '[data-step-progress]');
          expect(bar.width, 'the bar is drawn').toBeGreaterThan(40);
          expect(bar.right, 'the bar fits the viewport').toBeLessThanOrEqual(variant.width + 1);
          // Everything under the bar is still reachable: the last control (paste's "Use this link") scrolls into view and
          // takes a click where it is drawn, so the bar did not push it out of the page.
          const submit = tab.getByRole('button', { name: 'Use this link' });
          if ((await submit.count()) > 0) {
            await submit.scrollIntoViewIfNeeded();
            const hit = await submit.evaluate(node => {
              const r = node.getBoundingClientRect();
              const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return {
                reachable: top !== null && (top === node || node.contains(top)),
                bottom: r.bottom,
                viewport: window.innerHeight,
                scrollHeight: document.documentElement.scrollHeight,
                bodyHeight: document.body.getBoundingClientRect().height,
              };
            });
            expect(hit.reachable, 'Use this link takes a click where it is drawn').toBe(true);
            expect(hit.bottom, 'and sits inside the viewport').toBeLessThanOrEqual(hit.viewport + 1);
          }
          if (shotsDir !== '') {
            // The page scrolls inside the scene, which a full-page capture does not follow: shoot it with the room it needs.
            await tab.setViewportSize({ width: variant.width, height: 1_100 });
            await tab.screenshot({
              path: join(shotsDir, `${variant.name}-first-${state.name.replace(/\W+/g, '-')}.png`),
              fullPage: true,
            });
          }
        } finally {
          await context.close();
        }
      });
    }
  }
});
