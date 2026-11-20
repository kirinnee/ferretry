/**
 * THE CODEX SEGMENT'S FIRST-RUN PAGES (r11 O5), in a real browser over fixed fake data (no real name, path or login). The
 * scene (`fixtures/onboarding-scene.tsx`) draws the REAL pages inside the app's own `StepPageFrame`, with the footer's Next
 * running the page's registered `commit` the way the shell does. These asserts are the proof of the owner's lines:
 *
 *   (3, 5)  at 1280 the cards are STACKED (one x and width, y increasing), the demo is in `[data-step-demo]` to the RIGHT of
 *           them (gap > 32 px, top within 8 px of the first card's top), the page's own words are <= 160 characters, and the
 *           page has no button of its own (permission, conversations, import-choice). At 390 the demo is ABOVE the cards and
 *           <= 140 px tall, the three footer buttons are inside the viewport, and nothing scrolls sideways.
 *   (1, 5)  Back / Later / Next are 136 px wide (+-1) and >= 44 px tall at 1280; equal thirds inside the viewport at 390.
 *   (6)     no Codex page says "Claude" (the whole screen's text, light and dark, 390 and 1280), and the sign-in page mounts the
 *           add-login panel with the subject `harness:codex` that LOCKS it (Logins' own browser suite mounts the real panel
 *           with that subject and proves: no chooser, no grid, the link first, and the shared provider's summary naming
 *           Codex alone; the page cannot import it: another package is reached only through its contract).
 *   save    a pick writes NOTHING (a click or an arrow key); Next writes exactly once, `permissionMode` only; a pick back on
 *           the saved card clears the save; a held change keeps the page and a second Next tries again.
 *
 * Set `FY_O5_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_O5_SHOTS_DIR ?? '';

const SCENE_CSS = 'html, body, #root { min-height: 100%; margin: 0; }';

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'desktop-1280', width: 1_280, height: 800, phone: false },
] as const;
type Viewport = (typeof VIEWPORTS)[number];

/** Every page, with whether it has cards, a demo, and a button of its own. */
const PAGES = [
  { page: 'installed', cards: 0, demo: true },
  { page: 'sign-in', cards: 0, demo: false },
  { page: 'sign-in-link', cards: 0, demo: false },
  { page: 'sign-in-checking', cards: 0, demo: false },
  { page: 'import-choice', cards: 3, demo: true },
  { page: 'conversations', cards: 2, demo: true },
  { page: 'permission', cards: 2, demo: true },
  { page: 'permission-auto', cards: 2, demo: true },
  { page: 'permission-unknown', cards: 0, demo: false },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-o5-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/onboarding-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the onboarding scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const newContext = async (viewport: Viewport, mode: 'light' | 'dark'): Promise<BrowserContext> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  return context;
};

const open = async (context: BrowserContext, page: string, mode: 'light' | 'dark', extra = ''): Promise<Page> => {
  const tab = await context.newPage();
  await tab.goto(`${server?.url.origin ?? ''}/?page=${page}&theme=studio-${mode}${extra}`);
  await tab.waitForSelector('[data-codex-step]');
  // Let the card animation and the demo (about 1.5 s) finish: a shot shows the last frame.
  await tab.waitForTimeout((await tab.locator('[data-demo]').count()) > 0 ? 1_700 : 600);
  return tab;
};

const shot = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ fullPage: true, path: join(shotsDir, `${name}.png`) });
};

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly right: number;
  readonly bottom: number;
}

/** Everything the layout asserts need, measured in one pass. */
const measure = async (tab: Page) =>
  await tab.evaluate(() => {
    const box = (node: Element | null): Box => {
      const r = node?.getBoundingClientRect() ?? new DOMRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const body = document.querySelector('.fy-spf__body') as HTMLElement;
    const titles = [...document.querySelectorAll('[data-choice] .fy-cc__title')].map(
      node => (node as HTMLElement).innerText,
    );
    let words = body.innerText;
    for (const title of titles) words = words.replace(title, '');
    return {
      cards: [...document.querySelectorAll('[data-choice]')].map(box),
      demo: box(document.querySelector('[data-step-demo]')),
      hasDemo: document.querySelector('[data-step-demo] [data-demo]') !== null,
      words: words.replace(/\s+/gu, ' ').trim(),
      pageButtons: body.querySelectorAll('button').length,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      footer: ['[data-step-back]', '[data-step-later]', '[data-step-next]'].map(s => box(document.querySelector(s))),
      viewport: window.innerWidth,
      screen: document.body.innerText,
    };
  });

describe('r11 O5: every Codex page, laid out as the owner asked', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      for (const { page, cards, demo } of PAGES) {
        it(`${page}: stacked, demo ${viewport.phone ? 'above' : 'right'}, footer 136, no Claude, at ${viewport.name}, ${mode}`, async () => {
          const context = await newContext(viewport, mode);
          const tab = await open(context, page, mode);
          const m = await measure(tab);

          // (6) The whole screen never says Claude.
          expect(m.screen.toLowerCase(), 'the page never names Claude').not.toContain('claude');
          expect(m.overflowX).toBe(false);

          // (1, 5) The footer: three equal fixed buttons.
          for (const button of m.footer) {
            expect(button.h).toBeGreaterThanOrEqual(44);
            expect(button.x).toBeGreaterThanOrEqual(0);
            expect(button.right).toBeLessThanOrEqual(m.viewport);
          }
          const widths = m.footer.map(button => button.w);
          if (viewport.phone) expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
          else for (const width of widths) expect(Math.abs(width - 136)).toBeLessThanOrEqual(1);

          // (3) Stacked cards.
          expect(m.cards).toHaveLength(cards);
          for (let at = 1; at < cards; at += 1) {
            expect(Math.abs((m.cards[at]?.x ?? 0) - (m.cards[0]?.x ?? 1))).toBeLessThan(0.5);
            expect(Math.abs((m.cards[at]?.w ?? 0) - (m.cards[0]?.w ?? 1))).toBeLessThan(0.5);
            expect(m.cards[at]?.y ?? 0).toBeGreaterThan(m.cards[at - 1]?.bottom ?? 0);
          }

          // (3) The demo: right of the cards (or the page's words) on a desktop, above them on a phone.
          expect(m.hasDemo).toBe(demo);
          if (demo && cards > 0) {
            if (viewport.phone) {
              expect(m.demo.bottom).toBeLessThanOrEqual((m.cards[0]?.y ?? 0) + 1);
              expect(m.demo.h).toBeLessThanOrEqual(140);
            } else {
              expect(m.demo.x).toBeGreaterThan(Math.max(...m.cards.map(card => card.right)) + 32);
              expect(Math.abs(m.demo.y - (m.cards[0]?.y ?? 0))).toBeLessThanOrEqual(8);
            }
          }
          if (demo && cards === 0 && !viewport.phone) {
            const text = await tab.locator('[data-codex-step]').boundingBox();
            expect(m.demo.x).toBeGreaterThan((text?.x ?? 0) + (text?.width ?? 0) - 1);
          }

          // (5) Fewer words: the page's own words (cards' titles left out) fit a glance; no button of its own on a pick page.
          if (cards > 0) {
            expect(m.words.length, m.words).toBeLessThanOrEqual(160);
            expect(m.pageButtons).toBe(0);
          }
          await shot(tab, `${page}-${viewport.name}-${mode}`);
          await context.close();
        }, 60_000);
      }
});

describe('r11 O5: permission saves on Next only', () => {
  const puts = (tab: Page) => tab.evaluate(() => window.__puts as { text: string; path: string }[]);

  it('Skip -> Auto: a click and arrow keys write nothing; Next writes once, permissionMode only; Auto (saved) -> Next writes nothing', async () => {
    const context = await newContext(VIEWPORTS[1], 'light');
    const tab = await open(context, 'permission', 'light');
    expect(await tab.locator('input[value="skip"]').isChecked()).toBe(true);
    // The warning is the one line under the cards while Skip is selected: plain words and the real flag.
    const words = await tab.locator('[data-permission-words="skip"]').innerText();
    expect(words).toContain('Runs every command without asking, even deleting files.');
    expect(words).toContain('--dangerously-bypass-approvals-and-sandbox');
    await tab.locator('[data-choice="auto"]').click();
    await tab.waitForSelector('[data-choice="auto"][data-selected="true"]');
    await tab.keyboard.press('ArrowDown');
    await tab.keyboard.press('ArrowUp');
    expect(await puts(tab)).toEqual([]);
    // The demo follows the pick, and the warning is gone with Skip.
    expect(await tab.locator('[data-step-demo] [data-demo="permission-auto"]').count()).toBe(1);
    expect(await tab.locator('[data-permission-words]').count()).toBe(0);
    await tab.locator('[data-step-next]').click();
    await tab.waitForFunction(() => window.__puts.length > 0);
    await tab.waitForTimeout(200);
    const written = await puts(tab);
    expect(written).toHaveLength(1);
    // Only permissionMode differs from the file the page read.
    expect(written[0]?.text).toBe('binary: /fake/bin/codex\npermissionMode: auto\n');
    expect(written[0]?.path).toBe('harness-codex.yaml');
    // Auto is now the saved card: choosing Skip and back to Auto, then Next, writes nothing more.
    await tab.locator('[data-choice="skip"]').click();
    await tab.locator('[data-choice="auto"]').click();
    await tab.locator('[data-step-next]').click();
    await tab.waitForTimeout(300);
    expect(await puts(tab)).toHaveLength(1);
    await context.close();
  }, 60_000);

  it('on the saved card, Next writes nothing', async () => {
    const context = await newContext(VIEWPORTS[1], 'light');
    const tab = await open(context, 'permission-auto', 'light');
    expect(await tab.locator('input[value="auto"]').isChecked()).toBe(true);
    await tab.locator('[data-step-next]').click();
    await tab.waitForTimeout(300);
    expect(await puts(tab)).toEqual([]);
    expect(await tab.evaluate(() => window.__nextError)).toBe('');
    await context.close();
  }, 60_000);

  it('a change the daemon holds: the page stays, says why, and a second Next tries again', async () => {
    const context = await newContext(VIEWPORTS[1], 'light');
    const tab = await open(context, 'permission-auto', 'light', '&held=1');
    await tab.locator('[data-choice="skip"]').click();
    await tab.locator('[data-step-next]').click();
    await tab.waitForFunction(() => window.__nextError !== '');
    expect(await tab.evaluate(() => window.__nextError)).toContain('waiting for your confirmation');
    await tab.locator('[data-step-next]').click();
    await tab.waitForFunction(() => window.__puts.length > 1);
    expect(await puts(tab)).toHaveLength(2);
    await context.close();
  }, 60_000);

  it('a file the page cannot read safely offers no card and writes nothing', async () => {
    const context = await newContext(VIEWPORTS[1], 'light');
    const tab = await open(context, 'permission-unknown', 'light');
    expect(await tab.locator('[data-choice]').count()).toBe(0);
    await tab.locator('[data-step-next]').click();
    await tab.waitForTimeout(300);
    expect(await puts(tab)).toEqual([]);
    await context.close();
  }, 60_000);

  it('conversations: a click writes nothing; Next writes hostHistory once', async () => {
    const context = await newContext(VIEWPORTS[1], 'light');
    const tab = await open(context, 'conversations', 'light');
    await tab.locator('[data-choice="off"]').click();
    await tab.waitForSelector('[data-choice="off"][data-selected="true"]');
    expect(await puts(tab)).toEqual([]);
    await tab.locator('[data-step-next]').click();
    await tab.waitForFunction(() => window.__puts.length > 0);
    const written = await puts(tab);
    expect(written).toHaveLength(1);
    expect(written[0]?.text).toContain('hostHistory: false');
    await context.close();
  }, 60_000);
});

describe("r11 O5: the sign-in page is Codex's own", () => {
  it('a machine with no Codex login mounts the add-login panel LOCKED to Codex (subject harness:codex): no chooser, no grid, no Claude', async () => {
    const context = await newContext(VIEWPORTS[1], 'light');
    const tab = await open(context, 'sign-in', 'light');
    const slot = tab.locator('[data-fake-logins="add-login"]');
    await slot.waitFor({ state: 'visible' });
    // The subject is what Logins reads to lock the panel (`harnessOfSubject`); without it the panel opens on the tool chooser.
    expect(await slot.getAttribute('data-fake-logins-subject')).toBe('harness:codex');
    expect(await tab.locator('input[type="radio"], [role="radiogroup"], [data-provider-grid]').count()).toBe(0);
    expect((await tab.evaluate(() => document.body.innerText)).toLowerCase()).not.toContain('claude');
    await context.close();
  }, 60_000);

  it("a login that needs signing in mounts its own Codex sign-in, by its id (the link-first panel is Logins' own)", async () => {
    const context = await newContext(VIEWPORTS[1], 'light');
    const tab = await open(context, 'sign-in-link', 'light');
    const slot = tab.locator('[data-fake-logins="codex-login"]');
    await slot.waitFor({ state: 'visible' });
    expect(await slot.getAttribute('data-fake-logins-subject')).toBe('codex-main');
    await context.close();
  }, 60_000);
});
