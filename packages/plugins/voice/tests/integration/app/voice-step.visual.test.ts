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
import {
  arrowWalkRings,
  demoScroll,
  edgeRings,
  pinnedStrip,
  previewFit,
  ringContrastOf,
  sceneBuilder,
  sharedChromium,
  walkFocusRings,
} from '@ferretry/app/testing/browser';

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
  viewport: { readonly name: string; readonly width: number; readonly height: number; readonly phone: boolean },
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
  // The audio test is measured on its own (`audioText`, its own copy budget): the page's 160 characters are everything else.
  const audio = slot.querySelector('[data-voice-test]') as HTMLElement | null;
  const shown = audio?.style.display ?? '';
  if (audio !== null) audio.style.display = 'none';
  let text = slot.innerText;
  if (audio !== null) audio.style.display = shown;
  const titles = [
    ...[...slot.querySelectorAll('input[type=radio][aria-label]')].map(el => el.getAttribute('aria-label') ?? ''),
    ...[...slot.querySelectorAll('[data-setting-row] [id$="-label"]')].map(el => (el as HTMLElement).innerText),
  ];
  for (const title of titles) if (title !== '') text = text.replace(title, '');
  return text.replace(/\s+/g, ' ').trim();
}
/** What a person reads inside the audio test, as the page lays it out: its own copy budget, apart from the page's 160. */
function audioText(): string {
  const audio = document.querySelector('[data-voice-test]') as HTMLElement;
  return audio.innerText.replace(/\s+/g, ' ').trim();
}
/** The page's own text, outside the audio test: r11 O12's 160, unchanged. */
const SEEN_TEXT_MAX = 160;
/** How far below the window's bottom edge the footer may end at 1280x900: one short scroll of the wheel. */
const SHORT_SCROLL = 160;
/** The audio test's own copy: its heading, status line, hint and three buttons (measured: see the failure line, which prints the text). */
const AUDIO_TEXT_MAX = 200;

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

interface WaveProbe {
  kind: string;
  /** The picked engine has measurements, so the radar draws a shape. */
  shape: boolean;
  names: string[];
  states: string[];
  /** The words' clip at the loop's start and at 5 s in (live: written by 3 s; after Stop: by 4 s). */
  clipStart: string;
  clipLate: string;
  /** The picture is in its phone strip (the frame under 900 px, where the heading stacks over it): the words arrive by a fade there, never a clip. */
  narrow: boolean;
  opacityStart: string;
  opacityLate: string;
}
/**
 * Does the O8 picture really PLAY? Reads the browser's own animation list for the picture (a picture whose animation CSS was removed
 * has none), then seeks the words' animation to the loop's start and to 5 s in and reads the computed clip: hidden, then whole.
 * Destructive (it pauses them), so a test probes once per mount.
 */
const probeWave = (tab: Tab): Promise<WaveProbe> =>
  tab.evaluate(() => {
    const root = document.querySelector('[data-voice-demo]') as HTMLElement;
    const animations = root.getAnimations({ subtree: true }) as CSSAnimation[];
    const states = animations.map(animation => animation.playState);
    const text = root.querySelector('.fy-wd__text') as HTMLElement;
    const own = animations.find(animation => (animation.effect as KeyframeEffect).target === text);
    const clip = (): string => getComputedStyle(text).clipPath;
    let clipStart = 'none';
    let clipLate = 'none';
    let opacityStart = '0';
    let opacityLate = '1';
    if (own !== undefined) {
      own.pause();
      own.currentTime = 0;
      clipStart = clip();
      own.currentTime = 5_000;
      clipLate = clip();
      own.currentTime = 0;
      opacityStart = getComputedStyle(text).opacity;
      own.currentTime = 5_000;
      opacityLate = getComputedStyle(text).opacity;
    }
    return {
      kind: root.dataset.voiceDemo ?? '',
      shape: root.querySelector('.fy-wd__shape') !== null,
      names: [...new Set(animations.map(animation => animation.animationName))],
      states,
      clipStart,
      clipLate,
      narrow: (root.closest('.fy-spf') as HTMLElement).getBoundingClientRect().width < 900,
      opacityStart,
      opacityLate,
    };
  });

const expectWavePlays = (probe: WaveProbe) => {
  const kind = probe.kind;
  expect(probe.names).toContain('fy-wd-envelope');
  expect(probe.names).toContain('fy-wd-wobble');
  expect(probe.names).toContain(
    probe.narrow
      ? kind === 'live'
        ? 'fy-wd-words-live'
        : 'fy-wd-words-after'
      : kind === 'live'
        ? 'fy-wd-type-live'
        : 'fy-wd-type-after',
  );
  if (probe.shape) expect(probe.names).toContain('fy-wd-grow');
  for (const state of probe.states) expect(['running', 'finished']).toContain(state);
  // A phone's strip: the words are never clipped; they are faded out at the start and in at 5 s.
  if (probe.narrow) {
    expect(probe.clipStart).toBe('none');
    expect(probe.opacityStart).toBe('0');
    expect(probe.opacityLate).toBe('1');
    return;
  }
  // Words: hidden (all clipped away from the right) at the start, whole at 5 s.
  expect(probe.clipStart).toMatch(/inset\(0(px)? 100%/);
  expect(probe.clipLate).toMatch(/inset\(0(px)?\)|inset\(0(px)? 0(px)? 0(px)? 0(px)?\)|none/);
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
                '.fy-voice-step button:not(.fy-engine-mini):not(.fy-engine-info):not([role=radio]):not([data-test-action])',
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
          const audio = await tab.evaluate(audioText);
          expect(audio.length <= AUDIO_TEXT_MAX ? '' : `${audio.length} chars: ${audio}`).toBe('');
          // The picture plays: wave, words and radar are really animated, and the words are written between 0 and half a loop.
          expectWavePlays(await probeWave(tab));
          expect(g.stray).toEqual([]);
          expect(g.scrollX).toBeLessThanOrEqual(0);
          for (const button of g.buttons) expect(button.right).toBeLessThanOrEqual(g.viewport);
          if (viewport.phone) {
            expect(g.demo.h).toBeLessThanOrEqual(140);
            expect(g.demo.bottom).toBeLessThanOrEqual((g.cards[0]?.y ?? 0) + 1);
          } else {
            // All five cards are in the window at once. (O8 item 8 adds "Test your audio" under them, so the footer is below the fold on a
            // 900 px window; the owner asked for the test on this page.) The footer's Next must stay within ONE SHORT SCROLL: its bottom
            // edge no more than SHORT_SCROLL (160 px; measured 107) below the fold, so a person never has to hunt for it.
            expect(
              g.footerBottom - g.height,
              `Next is ${Math.round(g.footerBottom - g.height)} px below the fold`,
            ).toBeLessThanOrEqual(SHORT_SCROLL);
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
        expectWavePlays(await probeWave(tab));
        await tab.locator('.fy-engine-card[data-engine="off"] input').click();
        await tab.waitForFunction(() => document.querySelector('[data-voice-demo="off"]') !== null);
        // Off: no wave, no words to write, no radar shape; the picture says so instead of animating nothing.
        const off = await probeWave(tab);
        expect(off.names.filter(name => name !== 'fy-wd-pulse')).toEqual([]);
        expect(await tab.locator('[data-radar="none"]').count()).toBe(1);
        expect(await tab.locator('.fy-wd__shape').count()).toBe(0);
      } finally {
        await close();
      }
    }
  });

  it('with motion reduced the picture is one still frame: the wave drawn, the words whole, the radar shown (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', VOICE, CARD);
    try {
      await tab.emulateMedia({ reducedMotion: 'reduce' });
      await tab.waitForTimeout(300);
      const now = await tab.evaluate(() => ({
        names: (document.querySelector('[data-voice-demo]') as HTMLElement)
          .getAnimations({ subtree: true })
          .map(animation => (animation as CSSAnimation).animationName ?? animation.constructor.name),
        clip: getComputedStyle(document.querySelector('.fy-wd__text') as Element).clipPath,
        barHeights: [...document.querySelectorAll('.fy-wd__bar')].map(el =>
          Math.round(el.getBoundingClientRect().height),
        ),
      }));
      expect(now.names).toEqual([]);
      expect(now.clip).toBe('none');
      expect(new Set(now.barHeights).size, 'the still wave is uneven, so it reads as speech').toBeGreaterThan(5);
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
      await tab.waitForFunction(() => document.querySelectorAll('.fy-engine-card').length === 11);
      expect(
        await tab
          .locator('.fy-voice-step button:not(.fy-engine-mini):not(.fy-engine-info):not([data-test-action])')
          .count(),
      ).toBe(0);
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

/** The owner's "buttons are one fixed width" floor (r11 line 1): a text button is at least this wide. */
const BUTTON_MIN_WIDTH = 136;

/** Every visible button in the page body (footer and the cards' icon-only (i) / cancel excluded) with its label and width. */
const bodyButtons = (tab: Tab, scope: string) =>
  tab.evaluate(selector => {
    return [...document.querySelectorAll(`${selector} button`)]
      .filter(el => (el.textContent ?? '').trim() !== '' && !(el as HTMLButtonElement).hidden)
      .map(el => {
        const box = el.getBoundingClientRect();
        return { label: (el.textContent ?? '').trim(), w: box.width, h: box.height };
      })
      .filter(button => button.w > 0);
  }, scope);

describe('r11-1b G3: the Voice and Speed-ups buttons and their focus ring', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`every Install button is >= ${BUTTON_MIN_WIDTH} px wide, short list and every engine (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, VOICE, CARD);
        try {
          const short = await bodyButtons(tab, '.fy-voice-step .fy-engine-card');
          const installs = short.filter(button => /^(Install|Resume)/.test(button.label));
          expect(installs.length).toBeGreaterThan(0);
          for (const button of installs) {
            expect(button.w >= BUTTON_MIN_WIDTH ? '' : `${button.label}: ${button.w}px`).toBe('');
            expect(button.h).toBeGreaterThanOrEqual(44);
            // One width for every card, whatever its label says (the owner's "fixed width").
            expect(Math.abs(button.w - (installs[0]?.w ?? 0))).toBeLessThanOrEqual(1);
          }
          await tab.getByText('Show every engine').click();
          await tab.waitForFunction(() => document.querySelectorAll('.fy-engine-card').length === 11);
          const all = (await bodyButtons(tab, '.fy-voice-step .fy-engine-card')).filter(button =>
            /^(Install|Resume)/.test(button.label),
          );
          expect(all.length).toBeGreaterThan(installs.length);
          for (const button of all) {
            expect(button.w >= BUTTON_MIN_WIDTH ? '' : `${button.label}: ${button.w}px`).toBe('');
            expect(Math.abs(button.w - (installs[0]?.w ?? 0))).toBeLessThanOrEqual(1);
          }
          const scrollX = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(scrollX).toBeLessThanOrEqual(0);
          if (shotsDir !== '') {
            // The picture is of the END of the page: the last cards, then "Show every engine" with its ring on.
            await tab.keyboard.press('Tab');
            await tab.locator('.fy-voice-more > summary').focus();
            await tab.keyboard.press('Shift+Tab');
            await tab.keyboard.press('Tab');
            await tab.waitForTimeout(150);
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-voice-all-engines.png`) });
          }
        } finally {
          await close();
        }
      });

      it(`Save, Test and Remove are >= ${BUTTON_MIN_WIDTH} px wide on every key card (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, SPEEDUPS, '[data-device-key]');
        try {
          await tab.waitForTimeout(600);
          const buttons = (await bodyButtons(tab, '.fy-voice-step [data-device-key]')).filter(button =>
            /^(Save|Test|Remove)/.test(button.label),
          );
          expect(buttons.length).toBe(6);
          // C59 audit: on a phone a key card's Save, Test and Remove are ONE row of three equal tracks (Remove no longer alone on a
          // second row), so each is a third of the card, not the 136 px a roomier page keeps.
          const floor = viewport.width < 520 ? 100 : BUTTON_MIN_WIDTH;
          for (const button of buttons) {
            expect(button.w >= floor ? '' : `${button.label}: ${button.w}px`).toBe('');
            expect(button.h).toBeGreaterThanOrEqual(44);
          }
          if (viewport.width < 520) {
            const rows = await tab.evaluate(() =>
              Array.from(document.querySelectorAll('.fy-voice-step [data-device-key] .fy-vs-field')).map(field => {
                const tops = Array.from(field.querySelectorAll(':scope > button')).map(b =>
                  Math.round(b.getBoundingClientRect().top),
                );
                return new Set(tops).size;
              }),
            );
            expect(
              rows.every(count => count === 1),
              'Save, Test and Remove share one row on a phone',
            ).toBe(true);
          }
          const scrollX = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(scrollX).toBeLessThanOrEqual(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-speedups-buttons.png`) });
        } finally {
          await close();
        }
      });

      it(`no focus ring on the Voice or Speed-ups page is cut by the frame, 'Show every engine' included (${viewport.name}, ${theme})`, async () => {
        for (const [query, waitFor] of [
          [VOICE, CARD],
          [SPEEDUPS, '[data-device-key]'],
        ] as const) {
          const { tab, close } = await open(viewport, theme, query, waitFor);
          try {
            await tab.waitForTimeout(600);
            const walk = await walkFocusRings(tab);
            expect(walk.stops.length).toBeGreaterThan(3);
            if (query === VOICE) expect(walk.stops.some(stop => stop.label.includes('Show every engine'))).toBe(true);
            expect(walk.violations).toEqual([]);
            if (query === VOICE) {
              // r11-1c C2: the same walk AFTER "Show every engine" is open, plus every engine card by the arrow keys (the cards are
              // one radio group: one Tab stop). The last cards' rings used to be cut at the bottom of the frame (5.4 px).
              await tab.getByText('Show every engine').click();
              await tab.waitForFunction(() => document.querySelectorAll('.fy-engine-card').length === 11);
              const open = await walkFocusRings(tab, 150);
              expect(open.violations).toEqual([]);
              // The ring is drawn INSIDE the card, so no scroll can ever cut it: every case below is measured where the browser left
              // the focus (nothing scrolled by the probe), and the walk by the arrows must reach every engine, each a different one.
              const arrows = await arrowWalkRings(tab, 'input.fy-engine-radio', 'data-engine');
              expect(arrows.ids.length).toBe(10);
              expect(new Set(arrows.ids).size, `ArrowDown reached ten different engines: ${arrows.ids.join(',')}`).toBe(
                10,
              );
              expect(arrows.stops.length, 'every engine card was measured').toBe(10);
              // The two cases a scroll cannot be trusted with: a card 2 px under the frame top, pressed then Shift; and a card the frame
              // has left partly out of view, focused with preventScroll under keyboard modality.
              const edge = await edgeRings(tab, '.fy-engine-card', 'input.fy-engine-radio');
              expect(
                Math.abs(edge.nearTop.gap - 2),
                `a card sits 2 px under the frame top (${edge.nearTop.gap})`,
              ).toBeLessThan(1);
              expect(
                Math.abs(edge.nearTop.gapAtRing - 2),
                `the press did not move the card (${edge.nearTop.gapAtRing})`,
              ).toBeLessThan(1);
              expect(edge.partlyHidden.gap, `a card is partly above the frame (${edge.partlyHidden.gap})`).toBeLessThan(
                -10,
              );
              expect(edge.nearTop.stop?.painted, 'the pressed card has a ring after Shift').toBe(true);
              expect(edge.partlyHidden.stop?.painted, 'the partly hidden card has a ring').toBe(true);
              // The ring reads >= 3:1 against the card it sits on and against the page, on the card the arrows chose AND on one that is not.
              await tab.keyboard.press('Shift');
              await tab.locator('input.fy-engine-radio').last().focus();
              const chosen = await ringContrastOf(tab, '.fy-engine-card');
              const ringed = tab.locator('.fy-engine-card:has(.fy-engine-radio:focus-visible)');
              if (shotsDir !== '') {
                // The chosen card with its ring, and (below) one nobody chose: the page, and the card up close.
                await ringed.evaluate(node => node.scrollIntoView({ block: 'center' }));
                await tab.waitForTimeout(150);
                await tab.screenshot({
                  path: join(shotsDir, `${viewport.name}-${theme}-voice-card-ring-chosen-page.png`),
                });
                await ringed.screenshot({
                  path: join(shotsDir, `${viewport.name}-${theme}-voice-card-ring-chosen.png`),
                });
              }
              await tab.keyboard.press('Shift');
              await tab.locator('input.fy-engine-radio').first().focus();
              const plain = await ringContrastOf(tab, '.fy-engine-card');
              if (shotsDir !== '') {
                await ringed.evaluate(node => node.scrollIntoView({ block: 'center' }));
                await tab.waitForTimeout(150);
                await tab.screenshot({
                  path: join(shotsDir, `${viewport.name}-${theme}-voice-card-ring-plain-page.png`),
                });
                await ringed.screenshot({
                  path: join(shotsDir, `${viewport.name}-${theme}-voice-card-ring-plain.png`),
                });
              }
              expect(chosen, 'the card holding focus draws a ring').not.toBeNull();
              expect(plain, 'a card nobody chose draws a ring').not.toBeNull();
              for (const [which, contrast] of [
                ['chosen card', chosen],
                ['plain card', plain],
              ] as const) {
                expect(contrast?.card ?? 0, `${which}: ring vs the card's fill`).toBeGreaterThanOrEqual(3);
                expect(contrast?.page ?? 0, `${which}: ring vs the page`).toBeGreaterThanOrEqual(3);
              }
              // All three cases in one object, so a failure names every case that broke.
              expect({
                'ArrowDown walk (10 cards)': arrows.violations,
                'press + Shift, card 2 px from the top': edge.nearTop.stop?.violations,
                'preventScroll focus, card partly hidden': edge.partlyHidden.stop?.violations,
              }).toEqual({
                'ArrowDown walk (10 cards)': [],
                'press + Shift, card 2 px from the top': [],
                'preventScroll focus, card partly hidden': [],
              });
            }
          } finally {
            await close();
          }
        }
      });
    }
  }
});

/**
 * O8 item 8, in a real browser over fake data: the owner's "this animation kinda shit" (a sound wave that turns into text on top,
 * the voice's spec as a radar chart below), "this is the part to ask for audio permission and testing too" (ask for the
 * microphone, record a line and see it transcribed, hear a sample), and the states each of those can be in.
 *
 * The ASSERT, on computed geometry, the DOM and the fake device (never a snapshot): the wave sits above the radar at 1280 and
 * beside it, inside the frame's 140 px strip, at 390 (its labels 12 px or more, as text outside the drawing); the radar's vertices ARE the engine's numbers
 * (Sherpa reaches the top for speed and the full left for live words, Moonshine does not); permission is asked by a button
 * and never on arrival; a refusal names its remedy; a line is recorded with the picked engine and shows as words; a sample
 * reaches the speaker; no control sits outside its column or under the footer. Set `FY_VOICE_STEP_SHOTS_DIR` to keep the pictures.
 */
const SHERPA = `${VOICE}&saved=sherpa`;
const TEST = '[data-voice-test]';
const act = (tab: Tab, id: string) => tab.locator(`[data-test-action="${id}"]`);

describe('O8 item 8: the Voice picture', () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`the wave turns into text over the radar (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, SHERPA, '[data-voice-demo]');
        try {
          await tab.waitForTimeout(400);
          const g = await tab.evaluate(() => {
            const box = (selector: string) => {
              const rect = (document.querySelector(selector) as Element).getBoundingClientRect();
              return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, w: rect.width, h: rect.height };
            };
            const radar = document.querySelector('.fy-wd__radar') as SVGSVGElement;
            const labels = [...document.querySelectorAll('.fy-wd__axis')] as HTMLElement[];
            return {
              demo: box('[data-step-demo]'),
              wave: box('.fy-wd__wave'),
              words: box('.fy-wd__text'),
              radar: box('.fy-wd__radar'),
              // The names are HTML text outside the scaled drawing: their computed size IS what is drawn.
              axisPx: Math.min(...labels.map(el => Number.parseFloat(getComputedStyle(el).fontSize))),
              axisInsideSvg: document.querySelectorAll('.fy-wd__radar text').length,
              axisBoxes: labels.map(el => {
                const rect = el.getBoundingClientRect();
                return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, shown: rect.width > 0 };
              }),
              axes: labels.map(el => el.textContent),
              caption: (document.querySelector('.fy-wd__caption') as HTMLElement).textContent,
              vertices: [...document.querySelectorAll('.fy-wd__vertex')].map(el => [
                Number(el.getAttribute('cx')),
                Number(el.getAttribute('cy')),
              ]),
              bars: document.querySelectorAll('.fy-wd__bar').length,
              moreShown: getComputedStyle(document.querySelector('.fy-wd__more') as Element).display !== 'none',
              // What a person reads in the left label, as laid out (a hidden tail is not in innerText), and where it ends.
              liveWords: (document.querySelector('.fy-wd__axis[data-at="left"]') as HTMLElement).innerText
                .replace(/\s+/g, ' ')
                .trim(),
              liveMore: box('.fy-wd__axis[data-at="left"] .fy-wd__more'),
              hidden: radar.closest('[aria-hidden="true"]') !== null,
              scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          expect(g.bars).toBe(28);
          expect(g.axes.map(text => (text ?? '').trim())).toEqual(['Speed', 'Accuracy', 'Light', 'Live words']);
          // The whole name "Live words" is drawn on every width (on a phone its second word wraps under the first), inside the strip.
          expect(g.moreShown).toBe(true);
          expect(g.liveWords).toBe('Live words');
          expect(g.liveMore.w, 'the tail of "Live words" has a box').toBeGreaterThan(0);
          expect(g.liveMore.x).toBeGreaterThanOrEqual(g.demo.x);
          expect(g.liveMore.right, 'and ends before the radar').toBeLessThanOrEqual(g.radar.x + 1);
          expect(g.hidden, 'the picture is decorative: the cards and the test carry the words').toBe(true);
          expect(g.scrollX).toBeLessThanOrEqual(0);
          // The radar IS Sherpa's numbers: the top vertex is speed 0.97 of the radius (46) above the centre (120, 66), the left one is
          // live words at the full radius (Sherpa streams).
          expect(g.vertices[0]?.[1] ?? 0).toBeCloseTo(66 - 46 * 0.973, 0);
          expect(g.vertices[3]?.[0] ?? 0).toBeCloseTo(120 - 46, 0);
          if (viewport.phone) {
            expect(g.demo.h).toBeLessThanOrEqual(140);
            expect(g.wave.right, 'wave and words left of the radar').toBeLessThanOrEqual(g.radar.x + 1);
            expect(
              g.axisPx,
              `the radar's labels are readable on a phone (${g.axisPx.toFixed(1)} px)`,
            ).toBeGreaterThanOrEqual(12);
          } else {
            expect(g.wave.bottom, 'the wave is above the radar').toBeLessThanOrEqual(g.radar.y + 1);
            expect(g.words.y).toBeGreaterThan(g.wave.y);
            expect(g.axisPx).toBeGreaterThanOrEqual(12);
          }
          // The names are text beside the drawing, never SVG text that shrinks with it, and none is cut off by the strip.
          expect(g.axisInsideSvg).toBe(0);
          for (const box of g.axisBoxes) {
            expect(box.shown).toBe(true);
            expect(box.x).toBeGreaterThanOrEqual(g.demo.x);
            expect(box.right).toBeLessThanOrEqual(g.demo.right + 1);
            expect(box.bottom).toBeLessThanOrEqual(g.demo.bottom + 1);
          }
          // The specs stay available as text (the desktop caption; on a phone the cards' own bars carry them).
          expect((g.caption ?? '').length).toBeGreaterThan(0);
          expect(g.radar.x).toBeGreaterThanOrEqual(g.demo.x);
          expect(g.radar.right).toBeLessThanOrEqual(g.demo.right + 1);
          if (shotsDir !== '') {
            await tab.waitForTimeout(2_600);
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-o8-picture.png`) });
          }
        } finally {
          await close();
        }
      });
    }
  }

  it('the radar follows the pick: Moonshine has no live words; the browser voice draws an empty frame (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', SHERPA, '[data-voice-demo]');
    try {
      const left = () =>
        tab.evaluate(() => Number(document.querySelectorAll('.fy-wd__vertex')[3]?.getAttribute('cx') ?? 'NaN'));
      expect(await left()).toBeCloseTo(74, 0);
      await tab.locator('.fy-engine-card[data-engine="moonshine-base-en"] input').click();
      await tab.waitForFunction(() => document.querySelector('[data-voice-demo="after"]') !== null);
      expect(await left()).toBeCloseTo(120 - 46 * 0.2, 0);
      expect((await probeWave(tab)).kind).toBe('after');
      await tab.locator('.fy-engine-card[data-engine="browser"] input').click();
      await tab.waitForFunction(() => document.querySelector('[data-radar="none"]') !== null);
      expect(await tab.locator('.fy-wd__shape').count()).toBe(0);
      expect(await tab.locator('.fy-wd__caption').innerText()).toContain('no numbers');
    } finally {
      await close();
    }
  });
});

describe('O8 item 8: test your audio', () => {
  it('the browser voice is never recorded: Record is off, the page says to pick an on-device voice, and no recognition starts (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', `${VOICE}&saved=browser&mic=granted`, TEST);
    try {
      await tab.evaluate(() => {
        // Any native recognition the page starts is counted; the page must start none.
        const w = window as unknown as { __recognitions: number };
        w.__recognitions = 0;
        for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
          Object.defineProperty(window, name, {
            configurable: true,
            value: function Counted() {
              w.__recognitions += 1;
            },
          });
        }
      });
      await tab.locator('[data-mic="granted"]').waitFor({ state: 'visible' });
      expect(await act(tab, 'record').isDisabled()).toBe(true);
      expect(await tab.locator(TEST).innerText()).toContain('on-device voice');
      await act(tab, 'record').click({ force: true });
      await tab.waitForTimeout(300);
      expect(await tab.evaluate(() => (window as unknown as { __recognitions: number }).__recognitions)).toBe(0);
    } finally {
      await close();
    }
  });

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`asks for the microphone by a button, never on arrival; a yes unlocks recording (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, `${SHERPA}&mic=prompt`, TEST);
        try {
          await tab.locator('[data-mic="prompt"]').waitFor({ state: 'visible' });
          expect(((await fakeOf(tab)) as unknown as { micRequests: number }).micRequests).toBe(0);
          expect(await act(tab, 'record').isDisabled()).toBe(true);
          if (shotsDir !== '') {
            await tab.locator(TEST).scrollIntoViewIfNeeded();
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-o8-permission-prompt.png`) });
          }
          await act(tab, 'allow').click();
          await tab.locator('[data-mic="granted"]').waitFor({ state: 'visible' });
          expect(((await fakeOf(tab)) as unknown as { micRequests: number }).micRequests).toBe(1);
          expect(await act(tab, 'record').isDisabled()).toBe(false);
          const g = await tab.evaluate(() => {
            const rect = (el: Element) => el.getBoundingClientRect();
            const panel = rect(document.querySelector('[data-voice-test]') as Element);
            return {
              panel: { x: panel.x, right: panel.right },
              buttons: [...document.querySelectorAll('[data-test-action]')].map(el => ({
                h: rect(el).height,
                right: rect(el).right,
              })),
              viewport: window.innerWidth,
              scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          expect(g.scrollX).toBeLessThanOrEqual(0);
          for (const button of g.buttons) {
            expect(button.h).toBeGreaterThanOrEqual(44);
            expect(button.right).toBeLessThanOrEqual(g.panel.right);
          }
          expect(g.panel.right).toBeLessThanOrEqual(g.viewport);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-o8-permission-granted.png`) });
        } finally {
          await close();
        }
      });

      it(`a refusal says what to do, offers Try again and keeps Record off (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, `${SHERPA}&mic=prompt-denies`, TEST);
        try {
          await act(tab, 'allow').click();
          await tab.locator('[data-mic="denied"]').waitFor({ state: 'visible' });
          const text = await tab.locator('[data-mic="denied"]').innerText();
          expect(text).toContain('lock icon');
          expect(text).toContain('Microphone to Allow');
          expect(await act(tab, 'allow').innerText()).toContain('Try again');
          expect(await act(tab, 'record').isDisabled()).toBe(true);
          expect(((await fakeOf(tab)) as Fake).writes).toEqual([]);
          if (shotsDir !== '') {
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-o8-permission-denied.png`) });
            await open(viewport, theme, `${SHERPA}&mic=insecure&speech=none`, TEST).then(async other => {
              await other.tab.locator('[data-mic="unavailable"]').waitFor({ state: 'visible' });
              await other.tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-o8-unavailable.png`) });
              await other.close();
            });
          }
        } finally {
          await close();
        }
      });

      it(`records a line with the pick and shows the words; plays a sample to the speaker (${viewport.name}, ${theme})`, async () => {
        const { tab, close } = await open(viewport, theme, `${SHERPA}&mic=granted&speech=hold`, TEST);
        try {
          await act(tab, 'record').click();
          await tab.locator('[data-test-part="record"] [role="status"]').waitFor({ state: 'visible' });
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-o8-recording.png`) });
          await tab.locator('[data-test-said]').waitFor({ state: 'visible', timeout: 15_000 });
          expect(await tab.locator('[data-test-said]').innerText()).toContain('Move the deploy to Friday.');
          expect(((await fakeOf(tab)) as unknown as { sessions: number }).sessions).toBe(1);
          // A test changes nothing: no write reached the device settings.
          expect(((await fakeOf(tab)) as Fake).writes).toEqual([]);
          await act(tab, 'play').click();
          await act(tab, 'stop-sample').waitFor({ state: 'visible' });
          expect(((await fakeOf(tab)) as unknown as { spoken: string[] }).spoken).toEqual([
            'This is how Ferretry reads a reply out loud.',
          ]);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${theme}-o8-transcript-playback.png`) });
          // The page still goes on: Next is the footer's, untouched by the test.
          expect(await tab.locator('[data-step-next]').isDisabled()).toBe(false);
        } finally {
          await close();
        }
      });
    }
  }

  it('nothing heard and a failed engine each say so; no voice to read aloud disables Hear a sample (1280)', async () => {
    const quiet = await open(VIEWPORTS[0], 'studio-light', `${SHERPA}&mic=granted&take=silent`, TEST);
    try {
      await act(quiet.tab, 'record').click();
      await quiet.tab
        .locator('[data-test-part="record"] [role="alert"]')
        .waitFor({ state: 'visible', timeout: 15_000 });
      expect(await quiet.tab.locator('[data-test-part="record"] [role="alert"]').innerText()).toContain(
        'Nothing was heard',
      );
    } finally {
      await quiet.close();
    }
    const broken = await open(VIEWPORTS[0], 'studio-light', `${SHERPA}&mic=granted&take=fail&speech=none`, TEST);
    try {
      await act(broken.tab, 'record').click();
      await broken.tab
        .locator('[data-test-part="record"] [role="alert"]')
        .waitFor({ state: 'visible', timeout: 15_000 });
      expect(await broken.tab.locator('[data-test-part="record"] [role="alert"]').innerText()).toContain('microphone');
      expect(await act(broken.tab, 'play').isDisabled()).toBe(true);
      expect(await broken.tab.locator('[data-test-part="playback"]').innerText()).toContain('no voice to read aloud');
    } finally {
      await broken.close();
    }
  });

  it('with a pick that cannot be tested it says why and offers no recording (1280)', async () => {
    const { tab, close } = await open(VIEWPORTS[0], 'studio-light', `${VOICE}&mic=granted`, TEST);
    try {
      // Parakeet 110M is the arrival pick and is not installed in this fake: the test says to install it.
      await tab.waitForFunction(
        () => document.querySelector('[data-test-part="record"]')?.textContent?.includes('Install') === true,
      );
      expect(await act(tab, 'record').isDisabled()).toBe(true);
      await tab.locator('.fy-engine-card[data-engine="off"] input').click();
      await tab.waitForFunction(
        () => document.querySelector('[data-test-part="record"]')?.textContent?.includes('off') === true,
      );
      expect(((await fakeOf(tab)) as unknown as { sessions: number }).sessions).toBe(0);
    } finally {
      await close();
    }
  });
});

/**
 * O9 items 1 and 2, the Voice half: on a phone the heading and the demo are ONE pinned strip (the same frame layout Appearance uses),
 * opaque and as wide as the screen, with nothing of the page showing behind or around it at the top, halfway down and at the end; the
 * demo's words are never cut at the strip's edge. At 1440 the demo sits right of the cards and stays pinned. Every shot is kept when
 * `FY_VOICE_STEP_SHOTS_DIR` is set.
 */
describe('the pinned Voice strip (O9)', () => {
  const PHONE = { name: '390', width: 390, height: 844, phone: true } as const;
  const WIDE = { name: '1440', width: 1_440, height: 900, phone: false } as const;
  for (const theme of THEMES) {
    for (const where of ['top', 'mid', 'bottom'] as const) {
      it(`pins the heading and the demo over an opaque strip (390 ${theme}, scrolled to ${where})`, async () => {
        const { tab, close } = await open(PHONE, theme, VOICE, CARD);
        try {
          // Every engine open, so the page is long enough to scroll under the strip.
          await tab.locator('.fy-voice-more summary').click();
          await tab.waitForTimeout(300);
          const strip = await pinnedStrip(tab, where);
          await tab.waitForTimeout(150);
          expect(strip.scrollable, 'the page scrolls').toBeGreaterThan(200);
          expect(strip.opaque, 'the strip is opaque').toBe(true);
          expect(strip.pin.left, 'the strip starts at the screen edge').toBeLessThanOrEqual(0.5);
          expect(strip.pin.right, 'the strip runs to the other edge').toBeGreaterThanOrEqual(strip.screenWidth - 0.5);
          expect(strip.headingInside, 'the heading is inside the strip').toBe(true);
          expect(strip.behind, 'nothing of the page shows over the strip').toEqual([]);
          expect(strip.above, 'nothing of the page shows above the strip').toEqual([]);
          expect(strip.spill, 'the demo words fit the demo').toEqual([]);
          if (where !== 'top') expect(strip.pin.top, 'the strip is pinned at the top').toBeLessThanOrEqual(0.5);
          // The words are written 22%..88% (live) or 66%..88% (after Stop) into the 6 s loop: stand on 4.6 s so the shot shows them.
          await tab.evaluate(() => {
            for (const animation of document.getAnimations()) {
              animation.pause();
              animation.currentTime = 4_600;
            }
          });
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `390-${theme}-voice-pinned-${where}.png`) });
        } finally {
          await close();
        }
      });
    }
    it(`keeps the demo to the right and pinned (1440 ${theme})`, async () => {
      const { tab, close } = await open(WIDE, theme, VOICE, CARD);
      try {
        const g = await tab.evaluate(() => {
          const demo = (document.querySelector('.fy-spf__demo') as HTMLElement).getBoundingClientRect();
          const card = (document.querySelector('.fy-engine-card') as HTMLElement).getBoundingClientRect();
          return {
            demoX: demo.x,
            cardRight: card.right,
            position: getComputedStyle(document.querySelector('.fy-spf__demo') as Element).position,
          };
        });
        expect(g.demoX).toBeGreaterThan(g.cardRight + 32);
        expect(g.position).toBe('sticky');
        await standOnWords(tab);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `1440-${theme}-voice.png`) });
      } finally {
        await close();
      }
    });
  }
});

/**
 * O9 round 2 (jovanna's CHANGES on 746a92aaf9). 1: wherever the heading and the preview STACK (the frame under 900 px), the preview
 * is the compact one and sits whole inside its 140 px slot, at every width (it was cut at 650: the wide picture, 355 px tall, in a slot
 * that clips). 2: a screen under 560 px tall pins nothing on the wide layout either; at 900 tall the preview stays pinned.
 */
describe('the Voice preview fits its slot and the height guard holds (O9 round 2)', () => {
  const tall = (width: number, height = 844) =>
    ({ name: `${width}x${height}`, width, height, phone: width < 520 }) as const;
  for (const width of [390, 520, 650, 899, 900]) {
    for (const theme of THEMES) {
      it(`fits the whole preview inside the slot (${width} wide, ${theme})`, async () => {
        const { tab, close } = await open(tall(width), theme, VOICE, CARD);
        try {
          await tab.waitForTimeout(200);
          const fit = await previewFit(tab, '.fy-wd');
          expect(fit.outside, `parts of the preview outside the slot (slot ${JSON.stringify(fit.slot)})`).toEqual([]);
          expect(fit.clipped, 'the slot clips nothing').toBe(false);
          if (width < 900)
            expect(fit.slot.bottom - fit.slot.top, 'a stacked slot is at most 140 px tall').toBeLessThanOrEqual(140.5);
          await standOnWords(tab);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${width}x844-${theme}-voice.png`) });
        } finally {
          await close();
        }
      });
    }
  }
  const WIDE_SHORT = { name: '1440x559', width: 1_440, height: 559, phone: false } as const;
  const WIDE = { name: '1440x900', width: 1_440, height: 900, phone: false } as const;
  for (const theme of THEMES) {
    it(`does not pin the preview on a 559 px tall wide screen (${theme})`, async () => {
      const { tab, close } = await open(WIDE_SHORT, theme, VOICE, CARD);
      try {
        await tab.locator('.fy-voice-more summary').click();
        await tab.waitForTimeout(300);
        const scroll = await demoScroll(tab);
        expect(scroll.scrollable, 'the page scrolls').toBeGreaterThan(150);
        expect(scroll.position, 'the preview is not sticky').not.toBe('sticky');
        expect(scroll.topBefore - scroll.topAfter, 'the preview scrolls away with the page').toBeGreaterThan(
          scroll.moved - 2,
        );
        await standOnWords(tab);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `1440x559-${theme}-voice-scrolled.png`) });
      } finally {
        await close();
      }
    });
    it(`keeps the preview pinned on a 900 px tall wide screen (${theme})`, async () => {
      const { tab, close } = await open(WIDE, theme, VOICE, CARD);
      try {
        await tab.locator('.fy-voice-more summary').click();
        await tab.waitForTimeout(300);
        const scroll = await demoScroll(tab);
        expect(scroll.scrollable, 'the page scrolls').toBeGreaterThan(150);
        expect(scroll.position).toBe('sticky');
        expect(Math.abs(scroll.topAfter - 16), 'the preview stays 16 px from the top').toBeLessThanOrEqual(1);
        await standOnWords(tab);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `1440x900-${theme}-voice-scrolled.png`) });
      } finally {
        await close();
      }
    });
  }
});

/** Stand every animation on 4.6 s (the words are written 22%..88% into the 6 s loop), so a shot shows the transcript, not an empty line. */
const standOnWords = (tab: Tab) =>
  tab.evaluate(() => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = 4_600;
    }
  });
