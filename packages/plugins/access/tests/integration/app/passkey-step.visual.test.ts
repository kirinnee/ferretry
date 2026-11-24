/**
 * THE `access.passkey` STEP in a real browser over fake data (`fixtures/passkey-step-scene.tsx`): the real `PasskeyStep`
 * in the real `StepPageFrame`, a fake machine and a fake credential container (no real passkey is ever made).
 *
 *  - "Add a passkey" and "Not now" are buttons, each at least 44px tall, and the footer button is at least 44px tall
 *    and not full width;
 *  - nothing scrolls sideways at 390 or 1280;
 *  - arrow, Home and End do nothing; Enter and Space on "Not now" leave the page; a press on "Add a passkey" ends on
 *    "Passkey added".
 *
 * Set `FY_PASSKEY_STEP_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png` (`buttons`, `added`).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PASSKEY_STEP_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-passkey-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/passkey-step-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the passkey step scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  { name: 'desktop-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: 'desktop-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: 'phone-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: 'phone-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

const open = async (variant: Variant) => {
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
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}`);
  await tab.waitForSelector('[data-passkey-step] [data-passkey-add]');
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, problems, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const box = async (tab: Page, selector: string) => {
  const found = await tab.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`no box for ${selector}`);
  return found;
};

describe('the access.passkey step, in a real browser', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: two 44px buttons, a 44px footer button, no sideways scroll`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        await shot(tab, variant, 'buttons');
        const sizes = await tab
          .locator('[data-passkey-step] button')
          .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
        expect(sizes.length).toBe(2);
        // "Not now" is a real secondary button (a visible border), not the borderless ghost that reads as bare text.
        const later = await tab.locator('[data-passkey-later]').evaluate(node => ({
          variant: node.getAttribute('data-variant'),
          border: Number.parseFloat(getComputedStyle(node).borderTopWidth),
        }));
        expect(later.variant).not.toBe('ghost');
        expect(later.border).toBeGreaterThan(0);
        for (const height of sizes) expect(height).toBeGreaterThanOrEqual(44);
        const next = await box(tab, '[data-step-next]');
        expect(next.height).toBeGreaterThanOrEqual(44);
        expect(next.width).toBeLessThan(variant.width * 0.6);
        expect(
          await tab.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
        ).toBe(true);

        // r11 O10 (item 3): the two answers are STACKED, one fixed width, 12 px apart, both explicit buttons.
        const add = await box(tab, '[data-passkey-add]');
        const later2 = await box(tab, '[data-passkey-later]');
        const flow = await tab
          .locator('[data-passkey-step] button')
          .first()
          .evaluate(node => {
            const row = node.parentElement as Element;
            const style = getComputedStyle(row);
            return { display: style.display, direction: style.flexDirection };
          });
        console.log(
          `${variant.name} passkey step: add ${add.width}x${add.height} @${add.x},${add.y}; not-now ${later2.width}x${later2.height} @${later2.x},${later2.y}; row ${flow.display}/${flow.direction}`,
        );
        // C59 O3 / O8-2: the shared answer row: a phone stacks them full width (the way on above), a desktop puts Not now
        // and Add a passkey side by side as one group at the right end of one row.
        expect(add.width, 'width of 136 px or more').toBeGreaterThanOrEqual(136);
        expect(later2.width, 'Not now keeps the minimum too').toBeGreaterThanOrEqual(136);
        // Q6 (ruling C-6): content-sized, never the column's full width, on a phone too.
        expect(add.width, 'Add a passkey is not full width').toBeLessThan(variant.width - 80);
        expect(later2.width, 'Not now is not full width').toBeLessThan(variant.width - 80);
        if (variant.phone) {
          // C59 follow-up (f7487677f5): the keyboard order IS the visual order, so the row swaps the two buttons in the DOM
          // (Add first, then Not now) and stacks them as a plain column; a CSS `column-reverse` would draw one order and
          // tab in the other.
          expect(flow.direction, 'a phone stacks the two buttons').toBe('column');
          expect(
            await tab
              .locator('[data-passkey-step] button')
              .evaluateAll(nodes => nodes.map(node => node.hasAttribute('data-passkey-add'))),
            'the DOM order is the visual order: Add, then Not now',
          ).toEqual([true, false]);
          expect(later2.x, 'one left edge').toBeCloseTo(add.x, 0);
          expect(later2.y, 'Not now is under Add').toBeGreaterThan(add.y + add.height - 1);
          expect(later2.y - (add.y + add.height), 'the gap is 12 px').toBeCloseTo(12, 0);
        } else {
          expect(later2.width, 'one width').toBeCloseTo(add.width, 0);
          expect(flow.direction, 'a desktop puts them in a row').toBe('row');
          expect(Math.abs(later2.y - add.y), 'one row').toBeLessThanOrEqual(1);
          expect(later2.x, 'Not now is left of Add').toBeLessThan(add.x);
          expect(add.x - (later2.x + later2.width), 'Not now sits right beside Add (one 12px gap)').toBeCloseTo(12, 0);
        }

        // Moving through the page by key starts nothing: no ceremony, no leaving.
        await tab.locator('[data-passkey-add]').focus();
        for (const key of ['ArrowRight', 'ArrowDown', 'Home', 'End']) await tab.keyboard.press(key);
        expect(
          await tab.evaluate(
            () => (window as unknown as { __passkeyScene: { creates: number } }).__passkeyScene.creates,
          ),
        ).toBe(0);
        expect(
          await tab.evaluate(() => (window as unknown as { __passkeyScene: { nexts: number } }).__passkeyScene.nexts),
        ).toBe(0);
        expect(await tab.locator('[data-passkey-step-added]').count()).toBe(0);
        // Enter and Space on "Not now" act (it moves on); then Space on "Add a passkey" runs the fake ceremony.
        await tab.locator('[data-passkey-later]').focus();
        await tab.keyboard.press('Enter');
        await tab.keyboard.press('Space');
        expect(
          await tab.evaluate(() => (window as unknown as { __passkeyScene: { nexts: number } }).__passkeyScene.nexts),
        ).toBe(2);
        await tab.locator('[data-passkey-add]').focus();
        await tab.keyboard.press('Space');
        await tab.waitForSelector('[data-passkey-step-added]');
        expect(await tab.locator('[data-passkey-add]').count()).toBe(0);
        await shot(tab, variant, 'added');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});
