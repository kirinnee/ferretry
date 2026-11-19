/**
 * THE `access.passkey` STEP in a real browser over fake data (`fixtures/passkey-step-scene.tsx`): the real `PasskeyStep`
 * in the real `StepPageFrame`, a fake machine and a fake credential container (no real passkey is ever made).
 *
 *  - the two cards sit in ONE row on a desktop and are not full width (each at most 320px); they stack on a phone;
 *  - each card is at least 44px tall, and the footer button is at least 44px tall and not full width;
 *  - nothing scrolls sideways at 390 or 1280;
 *  - choosing "Add a passkey now" ends on "Passkey added" with the card checked.
 *
 * Set `FY_PASSKEY_STEP_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png` (`cards`, `added`).
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
  await tab.waitForSelector('[data-passkey-step] [data-choice-cards]');
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
    it(`${variant.name}: two roomy cards, a 44px footer button, no sideways scroll`, async () => {
      const { tab, problems, close } = await open(variant);
      try {
        await shot(tab, variant, 'cards');
        const cards = await tab.locator('[data-choice-cards] label').evaluateAll(nodes =>
          nodes.map(node => {
            const rect = node.getBoundingClientRect();
            return { top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
          }),
        );
        expect(cards.length).toBe(2);
        for (const card of cards) expect(card.height).toBeGreaterThanOrEqual(44);
        if (variant.phone) expect(cards[0]?.top).toBeLessThan(cards[1]?.top ?? 0);
        else {
          expect(cards[0]?.top).toBe(cards[1]?.top as number);
          for (const card of cards) expect(card.width).toBeLessThanOrEqual(321);
        }
        const next = await box(tab, '[data-step-next]');
        expect(next.height).toBeGreaterThanOrEqual(44);
        expect(next.width).toBeLessThan(variant.width * 0.6);
        expect(
          await tab.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
        ).toBe(true);

        await tab.locator('[data-choice-cards] input[value="add"]').check({ force: true });
        await tab.waitForSelector('[data-passkey-step-added]');
        expect(await tab.locator('[data-choice-cards] input[value="add"]').isChecked()).toBe(true);
        await shot(tab, variant, 'added');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});
