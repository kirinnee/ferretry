/**
 * THE TWO FIRST-RUN VOICE PAGES in a real browser over fake data (`fixtures/voice-step-scene.tsx`): r11 O12's proof of the
 * owner's lines "i would put them vertically, and show the example animation on the right, and reduce the amount of
 * description" (item 3) and "make buttons have fixed width" (item 5), and of Parakeet 110M being what is chosen on arrival.
 *
 * The ASSERT, on computed geometry, the DOM and the fake device (never a snapshot):
 *   1280 — the engine cards share x and width and stack (y strictly increases); the demo sits right of them (> 32 px gap)
 *   with its top within 8 px of the first card's; the page text, by the plan's measure (the `.fy-sf-slot`'s innerText minus the card titles), is <= 160
 *   characters (measured 139 on Voice, 112 on Speed-ups); no in-body button except the cards' own controls (Install, the "i"); Parakeet 110M is checked on arrival;
 *   nothing is written by arriving, picking or the arrow keys; Next writes ONCE (or not at all when the pick is what is saved).
 *   390 — the demo sits above the cards and is <= 140 px tall, no sideways scroll, the footer buttons stay in the screen.
 * The Speed-ups page: one line, the demo on the right, the key cards stacked, no in-body button outside a key card, and a
 * pasted fake key reaches the vault once, sealed, and is in no DOM, storage or console afterwards.
 *
 * Set `FY_VOICE_STEP_SHOTS_DIR` to keep the pictures.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_VOICE_STEP_SHOTS_DIR ?? '';
const FAKE_KEY = 'gsk-fake-key-0123456789abcdef';

let browser: Awaited<ReturnType<typeof sharedChromium>>;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-voice-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/voice-step-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the Voice step scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
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

type Tab = Awaited<ReturnType<Awaited<ReturnType<typeof sharedChromium>>['newPage']>>;

async function open(
  viewport: (typeof VIEWPORTS)[number],
  theme: string,
  query: string,
  waitFor: string,
): Promise<{ tab: Tab; logs: string[]; close: () => Promise<void> }> {
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
  const logs: string[] = [];
  tab.on('console', message => logs.push(message.text()));
  tab.on('pageerror', error => logs.push(String(error)));
  await tab.goto(`${origin}/?theme=${theme}${viewport.phone ? '&phone=1' : ''}${query}`);
  await tab.locator(waitFor).first().waitFor({ state: 'visible' });
  return { tab, logs, close: () => context.close() };
}

interface Fake {
  writes: unknown[];
  commits: number;
  done: number;
  skipped: string[];
  keyPuts: { slot: string; sealed: boolean }[];
}
const fakeOf = (tab: Tab) => tab.evaluate(() => (window as unknown as { __fake: Fake }).__fake);

/**
 * The PAGE TEXT, by the plan's own measure (r11 PLAN, the "text <= 160 characters" assert): the `.fy-sf-slot`'s innerText, the
 * setup flow's own page slot, minus the card titles. innerText is what a person reads (hidden text is not in it); a card's
 * title is the name its radio carries (`aria-label`) or its setting row's label. The slot is the shell's own element, so no
 * selector here names a page's inner parts. Input placeholders are not text and do not count; the demo counts only if it is
 * inside the slot (it is drawn in the frame's demo column, outside it). Self-contained: Playwright runs its source in the page.
 */
function slotText(): string {
  const slot = document.querySelector('.fy-sf-slot') as HTMLElement;
  let text = slot.innerText;
  const titles = [
    ...[...slot.querySelectorAll('input[type=radio][aria-label]')].map(el => el.getAttribute('aria-label') ?? ''),
    ...[...slot.querySelectorAll('[data-setting-row] [id$="-label"]')].map(el => (el as HTMLElement).innerText),
  ];
  for (const title of titles) if (title !== '') text = text.replace(title, '');
  return text.replace(/\s+/g, ' ').trim();
}
const SEEN_TEXT_MAX = 160;

interface DemoProbe {
  names: string[];
  states: string[];
  atStart: string[];
  atEnd: string[];
}
/**
 * Does the demo really PLAY? Reads the browser's own animation list for the demo (a demo whose animation CSS was removed has
 * none), checks each runs on its own, then seeks each to its first and last frame and reads the element's computed opacity:
 * 0 before, 1 after. Destructive (it pauses them), so a test probes once per mount.
 */
const probeDemo = (tab: Tab, demo: string): Promise<DemoProbe> =>
  tab.evaluate(selector => {
    const root = document.querySelector(selector) as HTMLElement;
    const animations = root.getAnimations({ subtree: true }) as CSSAnimation[];
    const targets = animations.map(animation => (animation.effect as KeyframeEffect).target as HTMLElement);
    const states = animations.map(animation => animation.playState);
    const opacity = (el: HTMLElement) => getComputedStyle(el).opacity;
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
    }
    const atStart = targets.map(opacity);
    for (const animation of animations) animation.currentTime = animation.effect?.getComputedTiming().endTime as number;
    const atEnd = targets.map(opacity);
    return { names: animations.map(animation => animation.animationName), states, atStart, atEnd };
  }, demo);

const expectPlays = (probe: DemoProbe, count: number) => {
  expect(probe.names).toEqual(Array<string>(count).fill('fy-vd-word'));
  for (const state of probe.states) expect(['running', 'finished']).toContain(state);
  expect(probe.atStart).toEqual(Array<string>(count).fill('0'));
  expect(probe.atEnd).toEqual(Array<string>(count).fill('1'));
};

const VOICE = '&view=voice';
const SPEEDUPS = '&view=speedups';
const CARD = '.fy-engine-card';

describe('the Voice first-run page', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`cards stack, demo on the right, Parakeet 110M chosen, one line (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, VOICE, CARD);
        try {
          await tab.waitForTimeout(1_800);
          const g = await tab.evaluate(() => {
            const rect = (el: Element) => el.getBoundingClientRect();
            const cards = [...document.querySelectorAll('.fy-engine-card')].map(el => rect(el));
            const demo = rect(document.querySelector('[data-step-demo]') as Element);
            const buttons = [...document.querySelectorAll('[data-step-footer] button')].map(el => rect(el));
            const list = document.querySelector('[role=radiogroup]') as Element;
            const slot = document.querySelector('.fy-spf__body, .fy-sf-slot, [data-step-body]') ?? document.body;
            // The page's own prose: its text with the card list taken out.
            const clone = slot.cloneNode(true) as HTMLElement;
            clone.querySelector('[role=radiogroup]')?.remove();
            clone.querySelector('[data-step-demo]')?.remove();
            const stray = [
              ...document.querySelectorAll(
                '.fy-voice-step button:not(.fy-engine-mini):not(.fy-engine-info):not([role=radio])',
              ),
            ].map(el => el.textContent);
            return {
              cards: cards.map(c => ({ x: c.x, y: c.y, w: c.width, right: c.right, bottom: c.bottom })),
              demo: { x: demo.x, y: demo.y, bottom: demo.bottom, h: demo.height },
              buttons: buttons.map(b => ({ w: b.width, h: b.height, right: b.right })),
              scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              viewport: window.innerWidth,
              height: window.innerHeight,
              footerBottom: (document.querySelector('[data-step-footer]') as Element).getBoundingClientRect().bottom,
              checked: (document.querySelector('.fy-engine-card[data-selected=true]') as HTMLElement | null)?.dataset
                .engine,
              prose: (list.parentElement?.querySelector('.fy-voice-step-line') as HTMLElement | null)?.innerText ?? '',
              stray,
              nativeSelects: document.querySelectorAll('select').length,
            };
          });
          expect(g.cards.length).toBe(5);
          for (const card of g.cards) {
            expect(Math.abs(card.x - (g.cards[0]?.x ?? 0))).toBeLessThanOrEqual(1);
            expect(Math.abs(card.w - (g.cards[0]?.w ?? 0))).toBeLessThanOrEqual(1);
          }
          for (let i = 1; i < g.cards.length; i += 1)
            expect((g.cards[i]?.y ?? 0) > (g.cards[i - 1]?.y ?? 0)).toBe(true);
          expect(g.checked).toBe('parakeet-tdt-110m');
          expect(g.prose.length).toBeGreaterThan(0);
          // Everything a person reads in the page slot, card titles aside, not just the intro line.
          const seen = await tab.evaluate(slotText);
          // A failure shows the text itself, so what to cut is on screen.
          expect(seen.length <= SEEN_TEXT_MAX ? '' : `${seen.length} chars: ${seen}`).toBe('');
          // The demo plays: the browser has the animations running, and each takes its word from invisible to seen.
          expectPlays(await probeDemo(tab, '[data-voice-demo]'), 5);
          expect(g.stray).toEqual([]);
          expect(g.scrollX).toBeLessThanOrEqual(0);
          for (const button of g.buttons) expect(button.right).toBeLessThanOrEqual(g.viewport);
          if (viewport.phone) {
            expect(g.demo.h).toBeLessThanOrEqual(140);
            expect(g.demo.bottom).toBeLessThanOrEqual((g.cards[0]?.y ?? 0) + 1);
          } else {
            // All five cards and the footer's buttons are in the window at once: nothing to scroll to.
            expect(g.footerBottom).toBeLessThanOrEqual(g.height);
            expect(g.cards.at(-1)?.bottom ?? 0).toBeLessThanOrEqual(g.height);
            expect(g.demo.x).toBeGreaterThan((g.cards[0]?.right ?? 0) + 32);
            expect(Math.abs(g.demo.y - (g.cards[0]?.y ?? 0))).toBeLessThanOrEqual(8);
            for (const button of g.buttons) expect(Math.abs(button.w - 136)).toBeLessThanOrEqual(1);
          }
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-voice.png`) });
        } finally {
          await close();
        }
      });
    }
  }

  it('a pick or an arrow key writes nothing; Next writes the pick once (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', VOICE, CARD);
    try {
      expect(((await fakeOf(tab)) as Fake).writes).toEqual([]);
      await tab.locator('.fy-engine-card[data-engine="browser"] input').click();
      await tab.keyboard.press('ArrowDown');
      expect(((await fakeOf(tab)) as Fake).writes).toEqual([]);
      await tab.locator('.fy-engine-card[data-engine="browser"] input').click();
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect(((await fakeOf(tab)) as Fake).writes).toEqual([{ enabled: true, engine: 'browser' }]);
    } finally {
      await close();
    }
  });

  it('Next on the preselected Parakeet 110M saves it as this device’s pick, once (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', VOICE, CARD);
    try {
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect(((await fakeOf(tab)) as Fake).writes).toEqual([{ enabled: true, engine: 'parakeet-tdt-110m' }]);
    } finally {
      await close();
    }
  });

  it('what is already saved is shown chosen and Next writes nothing (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', `${VOICE}&saved=browser`, CARD);
    try {
      expect(await tab.locator('.fy-engine-card[data-engine="browser"]').getAttribute('data-selected')).toBe('true');
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect(((await fakeOf(tab)) as Fake).writes).toEqual([]);
    } finally {
      await close();
    }
  });

  it('Off is written as off, and a refused write keeps the page and tries again (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', `${VOICE}&save=fail`, CARD);
    try {
      await tab.locator('.fy-engine-card[data-engine="off"] input').click();
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-flow-commit-error]').waitFor({ state: 'visible' });
      expect(await tab.locator('[data-flow-commit-error]').innerText()).toContain('refused');
      expect(await tab.locator(CARD).count()).toBe(5);
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect(((await fakeOf(tab)) as Fake).writes).toEqual([{ enabled: false }]);
    } finally {
      await close();
    }
  });

  it('a pick plays the demo again: live words, then Off, each from its own first frame (1280, 390)', async () => {
    for (const viewport of VIEWPORTS) {
      const { tab, close } = await open(viewport, 'studio-light', VOICE, CARD);
      try {
        await tab.locator('.fy-engine-card[data-engine="browser"] input').click();
        await tab.waitForFunction(() => document.querySelector('[data-voice-demo="live"]') !== null);
        expectPlays(await probeDemo(tab, '[data-voice-demo]'), 5);
        await tab.locator('.fy-engine-card[data-engine="off"] input').click();
        await tab.waitForFunction(() => document.querySelector('[data-voice-demo="off"]') !== null);
        expectPlays(await probeDemo(tab, '[data-voice-demo]'), 1);
      } finally {
        await close();
      }
    }
  });

  it('with motion reduced the demo has no animation and shows every word (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', VOICE, CARD);
    try {
      await tab.emulateMedia({ reducedMotion: 'reduce' });
      const now = await tab.evaluate(() => ({
        animations: (document.querySelector('[data-voice-demo]') as HTMLElement).getAnimations({ subtree: true })
          .length,
        opacities: [...document.querySelectorAll('.fy-vd__word')].map(el => getComputedStyle(el).opacity),
      }));
      expect(now.animations).toBe(0);
      expect(now.opacities).toEqual(['1', '1', '1', '1', '1']);
    } finally {
      await close();
    }
  });

  it('storage that refuses the write keeps the page and says so; the next try that is kept moves on (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', `${VOICE}&save=denied-once`, CARD);
    try {
      await tab.locator('.fy-engine-card[data-engine="browser"] input').click();
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-flow-commit-error]').waitFor({ state: 'visible' });
      expect(await tab.locator('[data-flow-commit-error]').innerText()).toContain('would not keep');
      expect(await tab.locator('[data-next-page]').count()).toBe(0);
      expect(await tab.locator(CARD).count()).toBe(5);
      // The tab already holds the pick, so "what is saved" now equals it: Next still has to write it again.
      await tab.locator('[data-step-next]').click();
      await tab.locator('[data-next-page]').waitFor({ state: 'visible' });
      expect(((await fakeOf(tab)) as Fake).writes).toEqual([
        { enabled: true, engine: 'browser' },
        { enabled: true, engine: 'browser' },
      ]);
    } finally {
      await close();
    }
  });

  it('storage that keeps refusing never lets Next through (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', `${VOICE}&save=denied`, CARD);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await tab.locator('[data-step-next]').click();
        await tab.locator('[data-flow-commit-error]').waitFor({ state: 'visible' });
        expect(await tab.locator('[data-flow-commit-error]').innerText()).toContain('would not keep');
        await tab.waitForFunction(() => document.querySelector('[data-step-next]:not([disabled])') !== null);
      }
      expect(await tab.locator('[data-next-page]').count()).toBe(0);
      expect(((await fakeOf(tab)) as Fake).writes.length).toBe(3);
    } finally {
      await close();
    }
  });

  it('"Show every engine" opens the whole list and is not a button (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', VOICE, CARD);
    try {
      await tab.getByText('Show every engine').click();
      await tab.waitForFunction(() => document.querySelectorAll('.fy-engine-card').length === 10);
      expect(await tab.locator('.fy-voice-step button:not(.fy-engine-mini):not(.fy-engine-info)').count()).toBe(0);
      expect(((await fakeOf(tab)) as Fake).writes).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('the Speed-ups first-run page', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`one line, demo on the right, key cards stacked (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, SPEEDUPS, '[data-device-key]');
        try {
          await tab.waitForTimeout(1_800);
          const g = await tab.evaluate(() => {
            const rect = (el: Element) => el.getBoundingClientRect();
            const rows = [...document.querySelectorAll('[data-device-key]')].map(el => rect(el));
            const top = rect(document.querySelector('[data-speedups-step]') as Element).y;
            const demo = rect(document.querySelector('[data-step-demo]') as Element);
            return {
              top,
              rows: rows.map(r => ({ x: r.x, y: r.y, w: r.width, right: r.right })),
              demo: { x: demo.x, y: demo.y, bottom: demo.bottom, h: demo.height },
              scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              prose: (document.querySelector('.fy-voice-step-line') as HTMLElement | null)?.innerText ?? '',
              stray: [...document.querySelectorAll('.fy-voice-step button')]
                .filter(el => el.closest('[data-device-key]') === null && !el.hasAttribute('aria-expanded'))
                .map(el => el.textContent),
            };
          });
          expect(g.rows.length).toBe(2);
          expect(Math.abs((g.rows[0]?.x ?? 0) - (g.rows[1]?.x ?? 1))).toBeLessThanOrEqual(1);
          expect((g.rows[1]?.y ?? 0) > (g.rows[0]?.y ?? 0)).toBe(true);
          expect(g.prose.length).toBeGreaterThan(0);
          const seen = await tab.evaluate(slotText);
          // A failure shows the text itself, so what to cut is on screen.
          expect(seen.length <= SEEN_TEXT_MAX ? '' : `${seen.length} chars: ${seen}`).toBe('');
          expectPlays(await probeDemo(tab, '[data-speedups-demo]'), 1);
          expect(g.stray).toEqual([]);
          expect(g.scrollX).toBeLessThanOrEqual(0);
          if (viewport.phone) expect(g.demo.h).toBeLessThanOrEqual(140);
          else {
            expect(g.demo.x).toBeGreaterThan((g.rows[0]?.right ?? 0) + 32);
            // The page's own first row is its group header, so the demo lines up with the top of the page body.
            expect(Math.abs(g.demo.y - g.top)).toBeLessThanOrEqual(8);
          }
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-speedups.png`) });
        } finally {
          await close();
        }
      });
    }
  }

  it('a pasted key is sealed once, answers the step, and is nowhere in the page (1280)', async () => {
    const { tab, logs, close } = await open(VIEWPORTS[0], 'studio-light', SPEEDUPS, '[data-device-key]');
    try {
      const field = tab.locator('[data-device-key="groq"] input[type=password]');
      await field.fill(FAKE_KEY);
      await tab.locator('[data-device-key="groq"]').getByRole('button', { name: 'Save' }).click();
      await tab.locator('[data-device-key-saved]').waitFor({ state: 'visible' });
      const fake = (await fakeOf(tab)) as Fake;
      expect(fake.keyPuts.filter(put => put.slot.includes('groq'))).toEqual([
        { slot: expect.any(String), sealed: true },
      ]);
      expect(fake.done).toBe(1);
      const where = await tab.evaluate(key => {
        const stores = [localStorage, sessionStorage].map(s => JSON.stringify({ ...s }));
        return {
          html: document.documentElement.outerHTML.includes(key),
          stores: stores.some(s => s.includes(key)),
          fields: [...document.querySelectorAll('input')].some(el => el.value.includes(key)),
        };
      }, FAKE_KEY);
      expect(where).toEqual({ html: false, stores: false, fields: false });
      expect(logs.some(line => line.includes(FAKE_KEY))).toBe(false);
    } finally {
      await close();
    }
  });

  it('with Off picked it is skipped and draws nothing (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', `${SPEEDUPS}&saved=off`, '[data-step-footer]');
    try {
      expect(await tab.locator('[data-device-key]').count()).toBe(0);
      expect(((await fakeOf(tab)) as Fake).skipped).toEqual(['not-needed']);
    } finally {
      await close();
    }
  });
});
