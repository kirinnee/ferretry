/**
 * THE DAEMON-LESS FIRST RUN'S OWN PAGES in a real browser over fake data (`fixtures/start-screen-scene.tsx`), light and dark at
 * 390 and 1280 (r10 O5): the start screen's three cards (not the page wide, one row on a desktop and a stack on a phone, a
 * select animation that plays on a NEW choice), its auto-width Continue, the target question, and the install page with its
 * quiet "Let an agent do it" link and the shared footer. Set `FY_START_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;
type Page = Awaited<ReturnType<Awaited<ReturnType<Browser['newContext']>>['newPage']>>;

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_START_SHOTS_DIR ?? '';

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-start-screen-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/start-screen-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const open = async (variant: Variant, view: string, ready: string) => {
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
  await tab.goto(`${origin}/onboarding?view=${view}&theme=studio-${variant.scheme}`);
  try {
    await tab.waitForSelector(ready, { timeout: 8_000 });
  } catch (error) {
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

const shot = async (tab: Page, variant: Variant, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

const noOverflow = async (tab: Page): Promise<void> => {
  const overflow = await tab.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow, 'no horizontal overflow').toBe(false);
};

/** The box of the first element matching the selector. */
const boxOf = async (tab: Page, selector: string) => {
  const box = await tab.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`no box for ${selector}`);
  return box;
};

describe('the start screen', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: three cards that are not the page wide, an auto-width Continue, and a select that starts nothing`, async () => {
      const { tab, close } = await open(variant, 'start', '[data-choice-cards]');
      try {
        await noOverflow(tab);
        const cards = await Promise.all(
          ['first-time', 'add-client', 'add-daemon'].map(async id => await boxOf(tab, `label[data-choice="${id}"]`)),
        );
        if (!variant.phone) {
          for (const card of cards) expect(card.width, 'a card is never the page wide').toBeLessThanOrEqual(321);
        }
        if (variant.phone) {
          // A phone stacks them, each under the last.
          expect(cards[1]?.y ?? 0).toBeGreaterThan(cards[0]?.y ?? 0);
          expect(cards[2]?.y ?? 0).toBeGreaterThan(cards[1]?.y ?? 0);
        } else {
          // A desktop reads them in one row.
          expect(Math.abs((cards[1]?.y ?? 0) - (cards[0]?.y ?? 1))).toBeLessThan(2);
          expect(Math.abs((cards[2]?.y ?? 0) - (cards[0]?.y ?? 1))).toBeLessThan(2);
        }
        // Nothing chosen yet: Continue is off, in the design system's own flat disabled look (not-allowed cursor).
        expect(await tab.locator('[data-onboarding-continue]').isDisabled()).toBe(true);
        expect(await tab.locator('[data-onboarding-continue]').evaluate(node => getComputedStyle(node).cursor)).toBe(
          'not-allowed',
        );
        const go = await boxOf(tab, '[data-onboarding-continue]');
        expect(go.height).toBeGreaterThanOrEqual(44);
        expect(go.width, 'Continue is not the page wide').toBeLessThan(variant.width / 2);
        await shot(tab, variant, 'start');

        // A card chosen: the select animation plays, and the journey has NOT started.
        await tab.locator('input[value="first-time"]').check({ force: true });
        await tab.waitForTimeout(70);
        await shot(tab, variant, 'start-mid-select');
        expect(await tab.locator('[data-onboarding="setup"]').getAttribute('data-onboarding-screen')).toBe('entry');
        await tab.waitForTimeout(250);
        expect(await tab.locator('label[data-choice="first-time"]').getAttribute('data-selected')).toBe('true');
        await shot(tab, variant, 'start-selected');
      } finally {
        await close();
      }
    });
  }
});

describe('the target question', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: two cards, Back and Continue as auto-width buttons`, async () => {
      const { tab, close } = await open(variant, 'target', 'label[data-choice="other"]');
      try {
        await noOverflow(tab);
        const back = await boxOf(tab, '[data-onboarding-back="entry"]');
        const go = await boxOf(tab, '[data-onboarding-continue]');
        expect(back.height).toBeGreaterThanOrEqual(44);
        expect(go.height).toBeGreaterThanOrEqual(44);
        expect(go.width).toBeLessThan(variant.width / 2);
        await shot(tab, variant, 'target');
      } finally {
        await close();
      }
    });
  }
});

describe('the install stage', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: the commands, a quiet agent link, and a footer that is not the page wide`, async () => {
      const { tab, close } = await open(variant, 'install', '[data-onboarding-agent-instead]');
      try {
        await noOverflow(tab);
        const link = await boxOf(tab, '[data-onboarding-agent-instead]');
        expect(link.height).toBeGreaterThanOrEqual(44);
        expect(link.width, 'the agent link is not the page wide').toBeLessThan(variant.width * 0.6);
        const next = await boxOf(tab, '[data-onboarding-next]');
        expect(next.height).toBeGreaterThanOrEqual(44);
        expect(next.width, 'Next is not the page wide').toBeLessThan(variant.width / 2);
        // On a phone the footer is sticky: the way on is in reach without scrolling to the end of the page.
        if (variant.phone) expect(next.y + next.height).toBeLessThanOrEqual(variant.height);
        // Right aligned: Next ends at the page's right gutter on a desktop, as the shared page frame's footer does.
        if (!variant.phone) expect(next.x + next.width).toBeGreaterThan(variant.width / 2);
        expect(await tab.locator('text=Who installs it?').count()).toBe(0);
        await shot(tab, variant, 'install');
      } finally {
        await close();
      }
    });
  }
});

describe('the other computer page', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: the link to open there, and the same quiet agent link`, async () => {
      const { tab, close } = await open(variant, 'elsewhere', '[data-onboarding-agent-instead]');
      try {
        await noOverflow(tab);
        await shot(tab, variant, 'elsewhere');
      } finally {
        await close();
      }
    });
  }
});

describe('the Pair journey', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: opens on Access's pairing surface with no terminal command first`, async () => {
      const { tab, close } = await open(variant, 'pair', '[data-onboarding-open-pair]');
      try {
        await noOverflow(tab);
        expect(await tab.locator('text=Copy pair command').count()).toBe(0);
        expect(await tab.locator('[data-onboarding="setup"]').getAttribute('data-onboarding-screen')).toBe('scan');
        // G2: "Open the pairing page" is auto width and 44px tall, never the row wide.
        const openPair = await tab.locator('[data-onboarding-open-pair]').boundingBox();
        expect(openPair?.height ?? 0, 'at least 44 px tall').toBeGreaterThanOrEqual(43.5);
        expect(openPair?.width ?? Infinity, 'not the row wide').toBeLessThan(variant.width * 0.7);
        await shot(tab, variant, 'pair');
      } finally {
        await close();
      }
    });
  }
});

/** r11-1b G4: the daemon-less journey pages use O2's footer (136 px Back/Next, 44 px tall, 12 px apart) and 136 px body buttons. */
describe('the get-started pages: footer and body buttons', () => {
  const PAGES = [
    { view: 'install', ready: '[data-onboarding-next]' },
    { view: 'daemon', ready: '[data-onboarding-next]' },
    { view: 'local', ready: '[data-onboarding-back]' },
    { view: 'elsewhere', ready: '[data-onboarding-next]' },
    { view: 'pair', ready: '[data-onboarding-back]' },
  ] as const;
  for (const variant of VARIANTS) {
    for (const page of PAGES) {
      it(`${variant.name} ${page.view}: footer Back/Next are 136 px (+-1), >= 44 tall, 12 px apart; body buttons are >= 136`, async () => {
        const { tab, close } = await open(variant, page.view, page.ready);
        try {
          const footer = await tab.locator('[data-onboarding-actions] .kt-btn:visible').evaluateAll(nodes =>
            nodes.map(node => {
              const box = node.getBoundingClientRect();
              return { label: (node.textContent ?? '').trim(), x: box.x, w: box.width, h: box.height };
            }),
          );
          expect(footer.length, `${page.view}: the footer has Back (and Next)`).toBeGreaterThanOrEqual(1);
          for (const button of footer) {
            expect(button.w, `${page.view}: footer ${button.label} is 136 +-1`).toBeGreaterThanOrEqual(135);
            expect(button.w, `${page.view}: footer ${button.label} is 136 +-1`).toBeLessThanOrEqual(137);
            expect(button.h, `${page.view}: footer ${button.label} is >= 44 tall`).toBeGreaterThanOrEqual(43.5);
          }
          const [first, second] = footer;
          if (first !== undefined && second !== undefined)
            expect(Math.abs(second.x - (first.x + first.w) - 12), `${page.view}: 12 px apart`).toBeLessThanOrEqual(1);
          const body = await tab
            .locator('[data-onboarding="setup"] .kt-btn:visible')
            .evaluateAll(nodes =>
              nodes
                .filter(node => node.closest('[data-onboarding-actions]') === null)
                .map(node => ({ label: (node.textContent ?? '').trim(), w: node.getBoundingClientRect().width })),
            );
          for (const button of body)
            expect(button.w, `${page.view}: body button "${button.label}" is >= 136`).toBeGreaterThanOrEqual(135.5);
          await noOverflow(tab);
          await shot(tab, variant, `getstarted-${page.view}`);
        } finally {
          await close();
        }
      });
    }
  }
});
