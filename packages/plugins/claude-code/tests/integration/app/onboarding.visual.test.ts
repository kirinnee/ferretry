/**
 * THE CLAUDE SEGMENT'S FIRST-RUN PAGES in a real browser over fixed fake data (`fixtures/onboarding-scene.tsx`): r11 O4's
 * proof of the owner's lines (items 3, 5: options stacked, the demo on the right, fewer words, no page buttons, fixed-width
 * footer buttons) and of the one security rule of the permission page: ONLY Next writes, and it writes `permissionMode` only.
 *
 * The ASSERT, on computed geometry, the DOM and the fake daemon (never a snapshot):
 *   1280 — on every page with cards: the cards share x and width and stack (y increases); the demo sits right of them
 *   (> 32 px gap) and its top is within 8 px of the first card's; the page text, card titles left out, is <= 160 characters;
 *   Back/Next are 136 px wide. Permission: no button in the page body; Skip + Next -> exactly one PUT whose YAML differs
 *   from the original in the `permissionMode` line alone; Auto (= saved) + Next -> no PUT; arrow keys -> no PUT; a refused
 *   write keeps the page, shows the reason, and the next Next writes once.
 *   390 — the demo is above the first card and <= 140 px tall; no sideways scroll; the footer buttons are inside the screen.
 *
 * Set `FY_O4_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_O4_SHOTS_DIR ?? '';
const ORIGINAL = 'binary: /fake/bin/claude\npermissionMode: skip\nhostHistory: true\n';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-o4-'));
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
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(html, { headers: { 'content-type': 'text/html' } }),
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;
const THEMES = ['studio-light', 'studio-dark'] as const;
const CARD_PAGES = ['import-choice', 'conversations', 'permission'] as const;
const DEMO_PAGES = [...CARD_PAGES, 'installed'] as const;

type Tab = Awaited<ReturnType<Awaited<ReturnType<typeof sharedChromium>>['newPage']>>;
interface Fake {
  puts: { path: string; text: string }[];
  advanced: boolean;
}

async function open(viewport: (typeof VIEWPORTS)[number], theme: string, query: string) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=${theme}${query}`);
  await tab.locator('[data-onboarding-step]').waitFor({ state: 'visible' });
  return { tab, close: () => context.close() };
}

const fakeOf = (tab: Tab) => tab.evaluate(() => (window as unknown as { __fake: Fake }).__fake);
const lineDiff = (before: string, after: string): string[] =>
  after.split('\n').filter((line, index) => line !== before.split('\n')[index]);

describe('the Claude pages: stacked cards, the demo on the right, few words', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      for (const page of DEMO_PAGES)
        it(`${page}: layout at ${viewport.name}, ${theme}`, async () => {
          const { tab, close } = await open(viewport, theme, `&page=${page}`);
          try {
            await tab.waitForTimeout(1_800);
            const geometry = await tab.evaluate(() => {
              const rect = (el: Element) => el.getBoundingClientRect();
              const cards = [...document.querySelectorAll('[data-choice]')].map(el => rect(el));
              const demoEl = document.querySelector('[data-step-demo]') as Element;
              const demo = rect(demoEl);
              const body = document.querySelector('.cc-step') as HTMLElement;
              const titles = [...body.querySelectorAll('.fy-cc__title')].map(el => (el as HTMLElement).innerText);
              let text = body.innerText.replace(/\s+/g, ' ');
              for (const title of titles) text = text.replace(title, '');
              return {
                cards: cards.map(c => ({ x: c.x, y: c.y, w: c.width, right: c.right, bottom: c.bottom })),
                demo: {
                  x: demo.x,
                  y: demo.y,
                  w: demo.width,
                  h: demo.height,
                  bottom: demo.bottom,
                  drawn: demo.height > 0,
                  /** What the demo draws past its box (the frame clips it at 140px on a phone): 0 when nothing is cut off. */
                  clipped: Math.max(0, (demoEl as HTMLElement).scrollHeight - (demoEl as HTMLElement).clientHeight),
                },
                buttons: [...document.querySelectorAll('[data-step-footer] button')].map(b => ({
                  w: rect(b).width,
                  h: rect(b).height,
                  right: rect(b).right,
                })),
                text: text.trim(),
                scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                viewport: window.innerWidth,
              };
            });
            const { cards, demo, buttons } = geometry;
            console.log(
              `O4 ${page} ${viewport.name} ${theme}: text ${String(geometry.text.length)} chars; cards ${String(cards.length)}; demo x ${String(Math.round(demo.x))} y ${String(Math.round(demo.y))} h ${String(Math.round(demo.h))}; first card right ${String(Math.round(cards[0]?.right ?? 0))} y ${String(Math.round(cards[0]?.y ?? 0))}; footer widths ${buttons.map(b => String(Math.round(b.w))).join('/')}`,
            );
            expect(demo.drawn, 'the demo is drawn in the frame’s demo column').toBe(true);
            expect(geometry.scrollX).toBeLessThanOrEqual(0);
            for (const button of buttons) expect(button.right).toBeLessThanOrEqual(geometry.viewport);
            expect(geometry.text.length, `page text: ${geometry.text}`).toBeLessThanOrEqual(160);
            for (const card of cards) {
              expect(Math.abs(card.x - (cards[0]?.x ?? 0))).toBeLessThanOrEqual(1);
              expect(Math.abs(card.w - (cards[0]?.w ?? 0))).toBeLessThanOrEqual(1);
            }
            for (let i = 1; i < cards.length; i += 1) expect(cards[i]?.y ?? 0).toBeGreaterThan(cards[i - 1]?.y ?? 0);
            if (!viewport.phone) {
              if (cards.length > 0) {
                expect(demo.x).toBeGreaterThan((cards[0]?.right ?? 0) + 32);
                expect(Math.abs(demo.y - (cards[0]?.y ?? 0))).toBeLessThanOrEqual(8);
              }
              for (const button of buttons) expect(Math.abs(button.w - 136)).toBeLessThanOrEqual(1);
            } else {
              expect(demo.h).toBeLessThanOrEqual(140);
              expect(demo.clipped, 'nothing of the demo is cut off by the 140px limit').toBe(0);
              if (cards.length > 0) expect(demo.bottom).toBeLessThanOrEqual((cards[0]?.y ?? 0) + 1);
            }
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${page}-${viewport.name}-${theme}.png`) });
          } finally {
            await close();
          }
        });
});

describe('the permission page: only Next writes, and only permissionMode', () => {
  it('has no button of its own in the page body (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=permission');
    try {
      expect(await tab.locator('[data-step-page] .fy-spf__body button').count()).toBe(0);
      expect(await tab.locator('[data-permission-confirm]').count()).toBe(0);
      const text = await tab.evaluate(() => document.body.innerText);
      for (const old of ['Use Skip permissions', 'Keep Auto mode', 'Press “Use', 'Nothing is saved until'])
        expect(text).not.toContain(old);
    } finally {
      await close();
    }
  });

  for (const theme of THEMES)
    it(`Skip is selected: one line names the real flag; Auto + Next writes ONE put changing permissionMode only (${theme})`, async () => {
      const { tab, close } = await open(VIEWPORTS[0], theme, '&page=permission');
      try {
        // Saved mode is skip (the scene's file): the warning is visible and names the flag.
        const warning = tab.locator('[data-permission-consequence="skip"]');
        await warning.waitFor({ state: 'visible' });
        expect(await warning.innerText()).toContain('--dangerously-skip-permissions');
        expect(await warning.innerText()).toContain('deleting files');
        // An arrow key moves the focus and writes nothing; Enter selects the focused card and still writes nothing.
        await tab.locator('input[type="radio"]:checked').focus();
        await tab.keyboard.press('ArrowUp');
        await tab.waitForTimeout(300);
        expect((await fakeOf(tab)).puts.length).toBe(0);
        await tab.keyboard.press('Enter');
        await tab.waitForTimeout(300);
        expect((await fakeOf(tab)).puts.length).toBe(0);
        expect(await tab.locator('input[value="auto"]').isChecked()).toBe(true);
        expect(await tab.locator('[data-permission-consequence="skip"]').count()).toBe(0);
        // Clicking back to Skip shows the warning again and still writes nothing.
        await tab.locator('[data-choice="skip"]').click();
        await warning.waitFor({ state: 'visible' });
        await tab.locator('[data-choice="auto"]').click();
        expect((await fakeOf(tab)).puts.length).toBe(0);
        await tab.locator('[data-step-next]').click();
        await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
        const { puts } = await fakeOf(tab);
        expect(puts.length).toBe(1);
        expect(puts[0]?.path).toBe('harness-claude-code.yaml');
        expect(lineDiff(ORIGINAL, puts[0]?.text ?? '')).toEqual(['permissionMode: auto']);
      } finally {
        await close();
      }
    });

  it('the saved mode + Next writes nothing (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=permission');
    try {
      await tab.locator('[data-choice="skip"]').waitFor({ state: 'visible' });
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect((await fakeOf(tab)).puts.length).toBe(0);
    } finally {
      await close();
    }
  });

  it('a pick and back to the saved card writes nothing (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=permission');
    try {
      await tab.locator('[data-choice="auto"]').click();
      await tab.locator('[data-choice="skip"]').click();
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect((await fakeOf(tab)).puts.length).toBe(0);
    } finally {
      await close();
    }
  });

  it('a refused write keeps the page, says why, and the next Next writes once (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=permission&save=fail');
    try {
      await tab.locator('[data-choice="auto"]').click();
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-flow-commit-error]').waitFor({ state: 'visible' });
      expect(await tab.locator('[data-flow-commit-error]').innerText()).toContain('refused');
      expect(await tab.locator('[data-choice-cards]').isVisible()).toBe(true);
      expect((await fakeOf(tab)).puts.length).toBe(0);
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect((await fakeOf(tab)).puts.length).toBe(1);
    } finally {
      await close();
    }
  });
});

describe('the conversations page: Next saves hostHistory, nothing else', () => {
  it('Don’t show them + Next writes one put changing hostHistory only (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=conversations');
    try {
      expect(await tab.locator('[data-step-page] .fy-spf__body button').count()).toBe(0);
      await tab.locator('[data-choice="off"]').click();
      expect((await fakeOf(tab)).puts.length).toBe(0);
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      const { puts } = await fakeOf(tab);
      expect(puts.length).toBe(1);
      expect(lineDiff(ORIGINAL, puts[0]?.text ?? '')).toEqual(['hostHistory: false']);
    } finally {
      await close();
    }
  });
});

describe('the installed page', () => {
  it('draws the command and one Install button, the demo on the right, no confirm paragraph (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', '&page=installed');
    try {
      await tab.locator('[data-install-command]').waitFor({ state: 'visible' });
      expect(await tab.getByRole('button', { name: 'Install Claude Code' }).count()).toBe(1);
      expect(await tab.locator('[data-step-demo] [data-demo="installed"]').count()).toBe(1);
    } finally {
      await close();
    }
  });
});
